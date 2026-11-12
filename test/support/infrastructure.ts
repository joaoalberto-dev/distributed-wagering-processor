import { ListQueuesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { SQL } from 'bun';
import { afterAll, beforeAll } from 'bun:test';
import { type SetupResult, setup } from '../../scripts/setup.js';
import {
  type AppConfig,
  loadConfig,
} from '../../src/infrastructure/config/app-config.js';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client.js';
import { TEST_DATABASE, baseTestEnv } from './env.js';

/** One id per test process, so queues of concurrent runs never collide. */
const RUN_ID = Math.random().toString(36).slice(2, 8);

const REACH_TIMEOUT_MS = 3000;

let prepared: Promise<void> | undefined;

async function checkPostgres(ownerUrl: string): Promise<void> {
  const server = new URL(ownerUrl);
  server.pathname = '/postgres';
  const sql = new SQL(server.toString(), {
    connectionTimeout: REACH_TIMEOUT_MS / 1000,
    max: 1,
  });
  try {
    await sql`SELECT 1`;
  } catch (error) {
    throw new Error(
      `PostgreSQL is not reachable at ${server.host}. Start it with "docker compose up -d postgres ministack setup".`,
      { cause: error },
    );
  } finally {
    await sql.close();
  }
}

async function checkSqs(config: AppConfig): Promise<void> {
  const sqs = createSqsClient(config);
  try {
    await sqs.send(new ListQueuesCommand({ MaxResults: 1 }), {
      abortSignal: AbortSignal.timeout(REACH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `MiniStack is not reachable at ${config.aws.endpointUrl}. Start it with "docker compose up -d postgres ministack setup".`,
      { cause: error },
    );
  } finally {
    sqs.destroy();
  }
}

/** Checks both dependencies and prepares the test database, once per process. */
function prepareOnce(env: Record<string, string>): Promise<void> {
  prepared ??= (async () => {
    const config = loadConfig(env);
    await checkPostgres(config.database.ownerUrl);
    await checkSqs(config);
    await setup({ env, database: TEST_DATABASE });
  })();
  return prepared;
}

export class Infrastructure {
  #env: Record<string, string> | undefined;
  #setup: SetupResult | undefined;
  #sqs: SQSClient | undefined;

  constructor(
    readonly specName: string,
    private readonly extraEnv: Record<string, string> = {},
  ) {}

  /** The environment for this spec's processes: test database and its own queues. */
  get env(): Record<string, string> {
    return this.#ready(this.#env);
  }

  get config(): AppConfig {
    return loadConfig(this.env);
  }

  get queueUrls(): SetupResult['queueUrls'] {
    return this.#ready(this.#setup).queueUrls;
  }

  /** A client shared by the spec, destroyed after it. */
  get sqs(): SQSClient {
    this.#sqs ??= createSqsClient(this.config);
    return this.#sqs;
  }

  /** @internal */
  async prepare(): Promise<void> {
    const base = baseTestEnv();
    await prepareOnce(base);
    const queueSuffix = `-${RUN_ID}-${this.specName}`;
    const env = { ...base, ...this.extraEnv, SQS_QUEUE_SUFFIX: queueSuffix };
    this.#setup = await setup({ env, database: TEST_DATABASE });
    this.#env = env;
  }

  /** @internal */
  dispose(): void {
    this.#sqs?.destroy();
  }

  #ready<T>(value: T | undefined): T {
    if (value === undefined) {
      throw new Error(
        'Infrastructure is not ready: use it inside tests or hooks, not at load time',
      );
    }
    return value;
  }
}

export type InfrastructureOptions = {
  /**
   * Settings for the whole spec, applied when its queues are created and
   * passed to its processes, such as `SQS_VISIBILITY_TIMEOUT_SECONDS`.
   */
  readonly env?: Record<string, string>;
};

/**
 * Registers the hooks that check PostgreSQL and MiniStack (failing, never
 * skipping, when either is missing), prepare the test database, and create
 * this spec's own queues. Call it once at the top of every integration and
 * concurrency spec.
 */
export function useInfrastructure(
  specName: string,
  options: InfrastructureOptions = {},
): Infrastructure {
  if (!/^[a-z0-9-]{1,40}$/.test(specName)) {
    throw new Error(
      `Spec name "${specName}" must be lowercase kebab-case, up to 40 characters`,
    );
  }
  const infrastructure = new Infrastructure(specName, options.env);
  beforeAll(() => infrastructure.prepare());
  afterAll(() => infrastructure.dispose());
  return infrastructure;
}
