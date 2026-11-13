import { sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';
import { assignment } from './assignment.js';

const {
  settings,
  runId,
  wallets,
  targets,
  workloads,
  stages,
  smokeIterations,
} = JSON.parse(open(__ENV.LOAD_FIXTURES));
const unexpected = new Rate('unexpected_response');
const retries = new Counter('request_retries');
const unavailable = new Counter('service_unavailable');
const started = new Counter('started_workloads');
const completed = new Counter('completed_workloads');
const completionTime = new Trend('operation_completion_ms', true);

const executor =
  settings.profile === 'smoke'
    ? {
        executor: 'shared-iterations',
        vus: 3,
        iterations: smokeIterations,
        maxDuration: '30s',
      }
    : {
        executor: 'ramping-arrival-rate',
        startRate: 1,
        preAllocatedVUs: settings.vus,
        stages: stages.map(({ seconds, rate }) => ({
          duration: `${seconds}s`,
          target: rate,
        })),
      };
const thresholds = {
  unexpected_response: ['rate==0'],
  completed_workloads: ['count>0'],
};
if (settings.maxP95Ms !== null)
  thresholds.http_req_duration = [`p(95)<${settings.maxP95Ms}`];
if (settings.maxDropped !== null)
  thresholds.dropped_iterations = [`count<=${settings.maxDropped}`];

export const options = {
  scenarios: { [settings.profile]: { ...executor, gracefulStop: '15s' } },
  systemTags: ['status', 'method', 'name', 'scenario', 'expected_response'],
  summaryTrendStats: ['count', 'avg', 'med', 'p(50)', 'p(95)', 'p(99)', 'max'],
  thresholds,
};

function request(body, target, accepted, variant, lane) {
  const tags = {
    operation: body.kind,
    variant,
    lane,
    instance: String(target),
  };
  return {
    method: 'POST',
    url: `${targets[target]}/wagering/transactions`,
    body: JSON.stringify(body),
    params: {
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': body.externalTransactionId,
      },
      tags: { ...tags, name: 'POST /wagering/transactions' },
      timeout: '3s',
      redirects: 0,
      responseCallback: http.expectedStatuses(accepted),
    },
  };
}

function finish(req, started, firstResponse) {
  const { url, body, params } = req;
  let response = firstResponse ?? http.post(url, body, params);
  for (let retry = 0; response.status === 503; retry += 1) {
    unavailable.add(1, params.tags);
    if (retry === 2) break;
    sleep(1 + ((Number(params.tags.instance) + retry) % 3) / 10);
    retries.add(1, params.tags);
    response = http.post(url, body, params);
  }
  completionTime.add(Date.now() - started, params.tags);
  return response;
}

function submit(wallet, prefix, step, target, lane) {
  const body = {
    providerId: runId,
    externalTransactionId: `${prefix}-${step.id}`,
    roundId: prefix,
    gameId: 'load',
    walletId: wallet.id,
    playerId: wallet.playerId,
    kind: step.kind,
    money: { amount: step.amount, currency: step.currency ?? 'BRL' },
  };
  if (step.reference)
    body.referenceExternalTransactionId = `${prefix}-${step.reference}`;
  const next = (target + 1) % targets.length;
  if (step.duplicate) {
    const batch = [target, next].map((index) =>
      request(body, index, 200, 'concurrent', lane),
    );
    const started = Date.now();
    const copies = http.batch(batch);
    const concurrent = copies.map((response, index) =>
      finish(batch[index], started, response),
    );
    if (concurrent.some(({ status }) => status !== 200)) return false;
    const [first, second] = concurrent.map((response) => response.json());
    if (
      first.transactionId !== second.transactionId ||
      first.idempotentReplay === second.idempotentReplay ||
      first.balance?.amount !== second.balance?.amount ||
      first.status !== 'PROCESSED' ||
      second.status !== 'PROCESSED'
    )
      return false;
    const conflict = finish(
      request(
        { ...body, money: { ...body.money, amount: '2.00' } },
        next,
        409,
        'conflict',
        lane,
      ),
      Date.now(),
    );
    return (
      conflict.status === 409 &&
      conflict.json().error?.code === 'IDEMPOTENCY_KEY_CONFLICT'
    );
  }
  const response = finish(
    request(body, target, step.response, 'new', lane),
    Date.now(),
  );
  if (response.status !== step.response) return false;
  const result = response.json();
  if (
    result.idempotentReplay !== false ||
    typeof result.transactionId !== 'string'
  )
    return false;
  if (step.response === 202)
    return result.status === 'PENDING_REFERENCE' && result.balance === null;
  const status = step.response === 200 ? 'PROCESSED' : 'REJECTED';
  return (
    result.status === status &&
    result.failureCode === step.failure &&
    typeof result.balance?.amount === 'string'
  );
}

export default function () {
  started.add(1);
  const index = exec.scenario.iterationInTest;
  const { workload, walletIndex, lane } = assignment(
    index,
    settings,
    wallets.length,
  );
  const prefix = `${workload}-${index}`;
  let passed = true;
  try {
    for (const [stepIndex, step] of workloads[workload].entries()) {
      const target = (index + stepIndex) % targets.length;
      if (!submit(wallets[walletIndex], prefix, step, target, lane)) {
        passed = false;
        break;
      }
    }
  } catch {
    passed = false;
  }
  unexpected.add(!passed);
  if (passed) completed.add(1);
}

export function handleSummary(data) {
  return { [__ENV.LOAD_SUMMARY]: JSON.stringify(data, null, 2) };
}
