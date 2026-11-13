import { mkdir } from 'node:fs/promises';
import { availableParallelism, cpus, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { DeleteQueueCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { SQL, type Subprocess } from 'bun';
import {
  loadConfig,
  queueNames,
} from '../../src/infrastructure/config/app-config.js';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client.js';
import { setup } from '../setup.js';
import {
  LoadEvents,
  requireCondition,
  type Settings,
  verifyLoad,
} from './verify.js';
import {
  arrivalStages,
  K6_VERSION,
  SMOKE_ITERATIONS,
  OPENING,
  profiles,
  type Workload,
  workloads,
} from './workload.js';

function integer(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  requireCondition(
    Number.isSafeInteger(value) && value >= min && value <= max,
    `${name} must be an integer from ${min} to ${max}`,
  );
  return value;
}

function settingsFromEnv(): Settings {
  const profile = profiles.find(
    (value) => value === (process.env.LOAD_PROFILE ?? 'smoke'),
  );
  requireCondition(
    profile,
    `LOAD_PROFILE must be one of ${profiles.join(', ')}`,
  );
  const defaults =
    profile === 'distributed'
      ? 'bet'
      : profile === 'hot'
        ? 'bet,bet,replay'
        : 'mixed,bet,replay,rejection';
  const mix = (process.env.LOAD_MIX ?? defaults).split(',').map((name) => {
    requireCondition(
      Object.hasOwn(workloads, name),
      `Invalid workload ${name}`,
    );
    return name as Workload;
  });
  return {
    profile,
    mix,
    rate: integer('LOAD_RATE', 20, 1, 100_000),
    seconds: integer('LOAD_SECONDS', 10, 1, 3600),
    vus: integer('LOAD_VUS', 60, 3, 10_000),
    seed: integer('LOAD_SEED', 41, 0, 0xffffffff),
    wallets: integer('LOAD_WALLETS', profile === 'smoke' ? 6 : 30, 2, 5000),
    drainSeconds: integer('LOAD_DRAIN_SECONDS', 60, 1, 600),
    maxP95Ms:
      process.env.LOAD_MAX_P95_MS === undefined
        ? null
        : integer('LOAD_MAX_P95_MS', 0, 1, 60_000),
    maxDropped:
      process.env.LOAD_MAX_DROPPED === undefined
        ? null
        : integer('LOAD_MAX_DROPPED', 0, 0, 1_000_000),
  };
}

function localHost(url: URL) {
  requireCondition(
    ['127.0.0.1', 'localhost'].includes(url.hostname),
    'Load tests require loopback infrastructure and targets',
  );
}

function targetUrls() {
  const supplied = process.env.LOAD_TARGET_URLS;
  if (supplied !== undefined) {
    const targets = supplied.split(',').map((value) => {
      const url = new URL(value);
      localHost(url);
      requireCondition(
        url.protocol === 'http:' &&
          url.port &&
          url.pathname === '/' &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash,
        'Use http://127.0.0.1:PORT targets',
      );
      return `http://127.0.0.1:${url.port}`;
    });
    requireCondition(
      targets.length >= 3 && new Set(targets).size === targets.length,
      'Use at least three distinct target ports',
    );
    return targets;
  }
  const ports = Array.from({ length: 3 }, () =>
    Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data() {} },
    }),
  );
  try {
    return ports.map(({ port }) => `http://127.0.0.1:${port}`);
  } finally {
    for (const port of ports) port.stop(true);
  }
}

async function awaitReady(child: Subprocess, target: string) {
  const deadline = Date.now() + 15_000;
  do {
    requireCondition(
      child.exitCode === null,
      `App at ${target} exited; see its log`,
    );
    const response = await fetch(`${target}/health/ready`, {
      redirect: 'error',
      signal: AbortSignal.timeout(500),
    }).catch(() => undefined);
    // A process may have just failed to bind a caller-specified port.
    if (response?.ok && child.exitCode === null) return;
    await Bun.sleep(75);
  } while (Date.now() < deadline);
  throw new Error(`App readiness timed out at ${target}`);
}

async function stopChild(child: Subprocess) {
  if (child.exitCode === null && child.signalCode === null)
    child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    await child.exited;
  } finally {
    clearTimeout(timer);
  }
}

async function createWallet(target: string, playerId: string) {
  const response = await fetch(`${target}/wallets`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount: OPENING, currency: 'BRL' },
    }),
  });
  requireCondition(
    response.status === 201,
    `Fixture wallet creation returned ${response.status}`,
  );
  const wallet = (await response.json()) as { id: string; playerId: string };
  requireCondition(
    wallet.playerId === playerId && typeof wallet.id === 'string',
    'Invalid fixture wallet',
  );
  return wallet;
}

async function capture(
  targets: string[],
  folder: string,
  sample: string,
  sql: SQL,
  pids: number[],
) {
  await Promise.all(
    targets.map(async (target, index) => {
      const response = await fetch(`${target}/metrics`, {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      requireCondition(
        response.ok,
        `Metrics returned ${response.status} from instance ${index}`,
      );
      await Bun.write(
        join(folder, `metrics-${sample}-${index}.prom`),
        await response.text(),
      );
    }),
  );
  const [postgres] = (await sql`
    SELECT version(), current_setting('max_connections') AS max_connections,
      current_setting('shared_buffers') AS shared_buffers FROM pg_database LIMIT 1
  `) as Record<string, string>[];
  const processStatus = await Promise.all(
    pids.map(async (pid) => {
      const file = Bun.file(`/proc/${pid}/status`);
      return (await file.exists())
        ? (await file.text())
            .split('\n')
            .filter((line) => /^(VmRSS|VmHWM|Threads):/.test(line))
        : [];
    }),
  );
  await Bun.write(
    join(folder, `resources-${sample}.json`),
    JSON.stringify({ postgres, pids, processStatus }, null, 2),
  );
}

type MetricValues = Record<string, number>;
type Summary = {
  state: { testRunDurationMs: number };
  metrics: Record<string, { values: MetricValues }>;
};

async function historicalReplay(sql: SQL, target: string) {
  const [bet] = (await sql`
    SELECT t.id, t.external_transaction_id, t.provider_id, t.player_id, t.wallet_id,
      t.round_id, t.game_id, t.amount::text, t.currency, t.result_balance_amount::text
    FROM wager_transactions t JOIN wallets w ON w.id = t.wallet_id
    WHERE t.kind = 'BET' AND t.status = 'PROCESSED' AND t.result_balance_amount <> w.balance
    ORDER BY t.id LIMIT 1
  `) as {
    id: string;
    external_transaction_id: string;
    provider_id: string;
    player_id: string;
    wallet_id: string;
    round_id: string;
    game_id: string;
    amount: string;
    currency: string;
    result_balance_amount: string;
  }[];
  if (!bet) return false;
  const counts = async (): Promise<unknown> => sql`
    SELECT (SELECT count(*) FROM wager_transactions) AS transactions,
      (SELECT count(*) FROM wallet_ledger_entries) AS ledger,
      (SELECT count(*) FROM outbox) AS events
  `;
  const before = await counts();
  const response = await fetch(`${target}/wagering/transactions`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': bet.external_transaction_id,
    },
    body: JSON.stringify({
      kind: 'BET',
      providerId: bet.provider_id,
      externalTransactionId: bet.external_transaction_id,
      playerId: bet.player_id,
      walletId: bet.wallet_id,
      roundId: bet.round_id,
      gameId: bet.game_id,
      money: { amount: bet.amount, currency: bet.currency },
    }),
  });
  const result = (await response.json()) as {
    transactionId: string;
    idempotentReplay: boolean;
    balance?: { amount: string; currency: string };
  };
  requireCondition(
    response.status === 200 &&
      result.transactionId === bet.id &&
      result.idempotentReplay &&
      result.balance?.amount === bet.result_balance_amount &&
      result.balance.currency === 'BRL' &&
      Bun.deepEquals(before, await counts()),
    `Historical replay failed for ${bet.id}`,
  );
  return true;
}

async function requestBreakdown(path: string) {
  const counts: Record<string, number> = {};
  const input = Bun.file(path)
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(new TextDecoderStream());
  let remainder = '';
  for await (const chunk of input) {
    const lines = (remainder + chunk).split('\n');
    remainder = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.includes('"metric":"http_reqs"')) continue;
      const row = JSON.parse(line) as {
        type: string;
        data: { tags: Record<string, string>; value: number };
      };
      if (row.type !== 'Point') continue;
      const tags = row.data.tags;
      const key = [
        tags.scenario,
        tags.operation,
        tags.variant,
        tags.lane,
        tags.instance,
        tags.status,
      ].join('/');
      counts[key] = (counts[key] ?? 0) + row.data.value;
    }
  }
  return counts;
}

async function main() {
  const settings = settingsFromEnv();
  const k6 = process.env.K6_BIN ?? 'k6';
  const version = Bun.spawnSync([k6, 'version']).stdout.toString().trim();
  requireCondition(
    version.split(' ')[1]?.split('+')[0] === `v${K6_VERSION}`,
    `Use k6 v${K6_VERSION} via K6_BIN or PATH`,
  );
  const targets = targetUrls();
  for (const target of targets) {
    const port = Number(new URL(target).port);
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port,
      socket: { data() {} },
    });
    listener.stop(true);
  }
  const runId = `load-${Bun.randomUUIDv7()}`;
  const database = runId.replaceAll('-', '_');
  const folder = resolve(process.env.LOAD_RESULTS ?? 'load-results', runId);
  await mkdir(folder, { recursive: true });
  console.log(`Load run ${runId} • ${folder}`);

  const base = loadConfig(process.env);
  const owner = new URL(base.database.ownerUrl);
  const app = new URL(base.database.url);
  const endpoint = new URL(base.aws.endpointUrl);
  for (const url of [owner, app, endpoint]) localHost(url);
  requireCondition(
    !endpoint.username &&
      !endpoint.password &&
      endpoint.protocol === 'http:' &&
      base.aws.accessKeyId === 'test' &&
      base.aws.secretAccessKey === 'test',
    'Use a loopback MiniStack endpoint with test credentials',
  );
  requireCondition(
    owner.host === app.host,
    'Owner and application must use the same local PostgreSQL server',
  );
  owner.pathname = '/postgres';
  // A disposable role avoids altering the password of any existing app user.
  app.username = database;
  app.password = Bun.randomUUIDv7();
  const env = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'warn',
    DATABASE_URL: app.href,
    DATABASE_OWNER_URL: owner.href,
    AWS_REGION: base.aws.region,
    AWS_ENDPOINT_URL: endpoint.href,
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    SQS_QUEUE_SUFFIX: `-${runId}`,
  };
  const config = loadConfig(env);
  const sqs = createSqsClient(config);
  const server = new SQL(owner.href, { connectionTimeout: 5 });
  let sql: SQL | undefined;
  let created = false;
  let setupStarted = false;
  let reader: LoadEvents | undefined;
  let reading: Promise<void> | undefined;
  const apps: Subprocess[] = [];
  const interrupted = new AbortController();
  const terminate = () => interrupted.abort(new Error('Load run interrupted'));
  process.once('SIGINT', terminate);
  process.once('SIGTERM', terminate);
  try {
    await server.unsafe(`CREATE DATABASE "${database}"`);
    created = true;
    setupStarted = true;
    const provisioned = await setup({ env, database });
    sql = new SQL(provisioned.ownerUrl);
    for (const [index, target] of targets.entries()) {
      const child = Bun.spawn(['bun', 'dist/bootstrap/main.js'], {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ...env,
          DATABASE_URL: provisioned.databaseUrl,
          DATABASE_OWNER_URL: provisioned.ownerUrl,
          PORT: new URL(target).port,
          INSTANCE_ID: `${runId}-${index}`,
        },
        stdout: Bun.file(join(folder, `app-${index}.log`)),
        stderr: 'inherit',
      });
      apps.push(child);
      await awaitReady(child, target);
    }
    interrupted.signal.throwIfAborted();
    reader = new LoadEvents(sqs, provisioned.queueUrls.events);
    reading = reader.read();
    const wallets = [];
    for (let index = 0; index < settings.wallets; index += 1) {
      const target = targets[index % targets.length];
      requireCondition(target, 'Missing fixture target');
      wallets.push(await createWallet(target, Bun.randomUUIDv7()));
    }
    const pids = apps.map((app) => app.pid);
    const stages = arrivalStages(
      settings.profile,
      settings.seconds,
      settings.rate,
    );
    const fixturePath = join(folder, 'fixtures.json');
    const samplePath = join(folder, 'samples.json.gz');
    const summaryPath = join(folder, 'summary.json');
    await Bun.write(
      fixturePath,
      JSON.stringify({
        settings,
        runId,
        targets,
        wallets,
        workloads,
        stages,
        smokeIterations: SMOKE_ITERATIONS,
      }),
    );
    const revision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'])
      .stdout.toString()
      .trim();
    const gitStatus = Bun.spawnSync(['git', 'status', '--porcelain'])
      .stdout.toString()
      .trim();
    const metadata = {
      runId,
      revision,
      dirty: gitStatus.length !== 0,
      command: 'bun run test:load',
      settings,
      targets,
      pids,
      postgresHost: owner.host,
      sqsEndpoint: endpoint.origin,
      bun: Bun.version,
      k6: version,
      hardware: {
        os: process.platform,
        kernel: release(),
        cpu: cpus()[0]?.model,
        logicalCpus: availableParallelism(),
        memoryBytes: totalmem(),
      },
    };
    await Bun.write(
      join(folder, 'run.json'),
      JSON.stringify(metadata, null, 2),
    );
    await capture(targets, folder, 'before', sql, pids);
    const traffic = Bun.spawn(
      [
        k6,
        'run',
        '--no-color',
        '--out',
        `json=${samplePath}`,
        'load/traffic.js',
      ],
      {
        env: {
          PATH: process.env.PATH,
          LOAD_FIXTURES: fixturePath,
          LOAD_SUMMARY: summaryPath,
        },
        stdout: 'inherit',
        stderr: 'inherit',
        signal: interrupted.signal,
      },
    );
    const exit = await traffic.exited;
    await capture(targets, folder, 'traffic-ended', sql, pids);
    const summary = (await Bun.file(summaryPath).json()) as Summary;
    const metric = (name: string) => summary.metrics[name]?.values;
    const count = metric('completed_workloads')?.count ?? 0;
    const started = metric('iterations')?.count ?? 0;
    requireCondition(
      count > 0 &&
        count === started &&
        (settings.profile !== 'smoke' || count === SMOKE_ITERATIONS),
      `Incomplete workloads ${count}/${started}; inspect k6 samples`,
    );
    const verification = await verifyLoad({
      sql,
      sqs,
      queues: provisioned.queueUrls,
      reader,
      settings,
      wallets,
      count,
      targets,
      runId,
    });
    const replayChecked = await historicalReplay(sql, targets.at(-1) ?? '');
    requireCondition(
      !settings.mix.includes('mixed') || replayChecked,
      'Missing historical replay probe',
    );
    await capture(targets, folder, 'drained', sql, pids);
    const trafficSeconds = summary.state.testRunDurationMs / 1000;
    const requests = metric('http_reqs')?.count ?? 0;
    const breakdown = await requestBreakdown(samplePath);
    requireCondition(
      Object.values(breakdown).reduce((sum, count) => sum + count, 0) ===
        requests,
      'Request samples do not match the k6 summary',
    );
    for (const [index] of targets.entries()) {
      requireCondition(
        Object.keys(breakdown).some(
          (key) => key.split('/')[4] === String(index),
        ),
        `Instance ${index} received no measured traffic`,
      );
    }
    const scheduledSeconds = stages.reduce(
      (sum, stage) => sum + stage.seconds,
      0,
    );
    let previous = 1;
    let offered = 0;
    for (const stage of stages) {
      offered += ((previous + stage.rate) * stage.seconds) / 2;
      previous = stage.rate;
    }
    const expectedRequestsPerWorkload =
      settings.mix.reduce(
        (sum, kind) =>
          sum +
          workloads[kind].reduce(
            (count, step) => count + ('duplicate' in step ? 3 : 1),
            0,
          ),
        0,
      ) / settings.mix.length;
    const metrics = {
      trafficSeconds,
      arrivalStages: settings.profile === 'smoke' ? null : stages,
      offeredWorkloadsPerSecond:
        settings.profile === 'smoke' ? null : offered / scheduledSeconds,
      plannedRequestsPerSecond:
        settings.profile === 'smoke'
          ? null
          : (offered / scheduledSeconds) * expectedRequestsPerWorkload,
      requestsByScenarioOperationVariantLaneInstanceStatus: breakdown,
      requests,
      requestThroughput: requests / trafficSeconds,
      uniqueProcessedPerSecond: verification.processed / trafficSeconds,
      droppedIterations: metric('dropped_iterations')?.count ?? 0,
      retries: metric('request_retries')?.count ?? 0,
      retryAmplification:
        requests / (requests - (metric('request_retries')?.count ?? 0)),
      serviceUnavailable: metric('service_unavailable')?.count ?? 0,
      perAttemptMs: metric('http_req_duration'),
      operationCompletionMs: metric('operation_completion_ms'),
      httpFailureRate: metric('http_req_failed')?.rate ?? 0,
      unexpectedRate: metric('unexpected_response')?.rate ?? 0,
    };
    await Bun.write(
      join(folder, 'verification.json'),
      JSON.stringify({ ...verification, replayChecked }, null, 2),
    );
    await Bun.write(
      join(folder, 'report.json'),
      JSON.stringify(
        { ...metadata, metrics, verification, replayChecked, k6Exit: exit },
        null,
        2,
      ),
    );
    console.log(
      `Verified ${verification.operations} operations, ${verification.events} events and ${verification.wallets} wallets in ${runId}`,
    );
    requireCondition(
      exit === 0,
      `k6 exited ${exit}; inspect its threshold results`,
    );
  } catch (error) {
    await Bun.write(
      join(folder, 'failure.json'),
      JSON.stringify({ runId, error: String(error) }, null, 2),
    );
    throw error;
  } finally {
    process.removeListener('SIGINT', terminate);
    process.removeListener('SIGTERM', terminate);
    reader?.stop();
    const cleanup = await Promise.allSettled(apps.map(stopChild));
    await reading;
    await sql?.close();
    if (setupStarted) {
      for (const QueueName of Object.values(queueNames(config))) {
        try {
          const { QueueUrl } = await sqs.send(
            new GetQueueUrlCommand({ QueueName }),
          );
          if (QueueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl }));
        } catch (error) {
          if (!(error instanceof Error && error.name === 'QueueDoesNotExist'))
            cleanup.push({ status: 'rejected', reason: error });
        }
      }
    }
    try {
      if (created)
        await server.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
      if (setupStarted)
        await server.unsafe(`DROP ROLE IF EXISTS "${database}"`);
    } finally {
      sqs.destroy();
      await server.close();
    }
    requireCondition(
      cleanup.every((item) => item.status === 'fulfilled'),
      `Cleanup failed for ${runId}`,
    );
  }
}

try {
  await main();
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
