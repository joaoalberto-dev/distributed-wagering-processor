import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { SQL } from 'bun';
import {
  type AppConfig,
  loadConfig,
  queueNames,
} from '../src/infrastructure/config/app-config.js';
import { createSqsClient } from '../src/infrastructure/messaging/sqs-client.js';
import { migrate } from './migrate.js';

/** The application tables; the app role may read, insert and update them, never delete. */
const APP_TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox',
  'outbox',
];

/** Receives after which SQS itself moves a message to the DLQ: a backstop above every application budget. */
export const NATIVE_REDRIVE_MAX_RECEIVE_COUNT = 50;

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

export type SetupOptions = {
  /** Create this database if it is missing, and use it instead of the one in the URLs. */
  readonly database?: string;
  /** Overrides `SQS_QUEUE_SUFFIX`. */
  readonly queueSuffix?: string;
  readonly env?: Record<string, string | undefined>;
};

export type SetupResult = {
  readonly databaseUrl: string;
  readonly ownerUrl: string;
  readonly queueUrls: {
    readonly input: string;
    readonly deadLetter: string;
    readonly events: string;
  };
};

function withDatabase(url: string, database: string | undefined): string {
  if (database === undefined) return url;
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function identifier(value: string, what: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(
      `${what} "${value}" is not a plain lowercase SQL identifier`,
    );
  }
  return `"${value}"`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function ensureDatabase(
  ownerUrl: string,
  database: string,
): Promise<void> {
  const name = identifier(database, 'Database name');
  const sql = new SQL(withDatabase(ownerUrl, 'postgres'));
  try {
    const rows: unknown[] =
      await sql`SELECT 1 FROM pg_database WHERE datname = ${database}`;
    if (rows.length === 0) {
      try {
        await sql.unsafe(`CREATE DATABASE ${name}`);
      } catch (error) {
        // Another process created it between the check and the create.
        if ((error as { errno?: string }).errno !== '42P04') throw error;
      }
    }
  } finally {
    await sql.close();
  }
}

async function ensureAppRole(ownerUrl: string, appUrl: string): Promise<void> {
  const app = new URL(appUrl);
  const roleName = decodeURIComponent(app.username);
  const role = identifier(roleName, 'App role');
  const password = literal(decodeURIComponent(app.password));
  const database = identifier(
    decodeURIComponent(app.pathname.slice(1)),
    'Database name',
  );

  const sql = new SQL(ownerUrl);
  try {
    await sql.begin(async (tx) => {
      // Roles are cluster-wide; serialize concurrent setups so CREATE ROLE cannot race.
      await tx`SELECT pg_advisory_xact_lock(hashtext('wagering-setup-role'))`;
      const rows: unknown[] =
        await tx`SELECT 1 FROM pg_roles WHERE rolname = ${roleName}`;
      await tx.unsafe(
        rows.length === 0
          ? `CREATE ROLE ${role} LOGIN PASSWORD ${password}`
          : `ALTER ROLE ${role} LOGIN PASSWORD ${password}`,
      );
      await tx.unsafe(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
      await tx.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.unsafe(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);

      const existing: { table_name: string }[] = await tx`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ${sql([...APP_TABLES, 'mikro_orm_migrations'])}`;
      for (const { table_name: table } of existing) {
        const target = identifier(table, 'Table');
        await tx.unsafe(`REVOKE ALL ON ${target} FROM ${role}`);
        await tx.unsafe(
          table === 'mikro_orm_migrations'
            ? `GRANT SELECT ON ${target} TO ${role}`
            : `GRANT SELECT, INSERT, UPDATE ON ${target} TO ${role}`,
        );
      }
    });
  } finally {
    await sql.close();
  }
}

/** Creates the queue, or brings an existing one to the given attributes, and returns its URL. */
async function ensureQueue(
  sqs: SQSClient,
  name: string,
  attributes: Record<string, string>,
): Promise<string> {
  const all = { FifoQueue: 'true', ...attributes };
  try {
    const created = await sqs.send(
      new CreateQueueCommand({ QueueName: name, Attributes: all }),
    );
    if (created.QueueUrl !== undefined) return created.QueueUrl;
  } catch (error) {
    const code = (error as { name?: string }).name;
    if (code !== 'QueueAlreadyExists' && code !== 'QueueNameExists')
      throw error;
  }
  const { QueueUrl } = await sqs.send(
    new GetQueueUrlCommand({ QueueName: name }),
  );
  if (QueueUrl === undefined) throw new Error(`Queue ${name} has no URL`);
  await sqs.send(
    new SetQueueAttributesCommand({ QueueUrl, Attributes: attributes }),
  );
  return QueueUrl;
}

async function ensureQueues(
  config: AppConfig,
): Promise<SetupResult['queueUrls']> {
  const names = queueNames(config);
  const sqs = createSqsClient(config);
  try {
    const deadLetter = await ensureQueue(sqs, names.deadLetter, {});
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: deadLetter,
        AttributeNames: ['QueueArn'],
      }),
    );
    const deadLetterArn = Attributes?.QueueArn;
    if (deadLetterArn === undefined)
      throw new Error(`Queue ${names.deadLetter} has no ARN`);

    const input = await ensureQueue(sqs, names.input, {
      VisibilityTimeout: String(config.sqs.visibilityTimeoutSeconds),
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: deadLetterArn,
        maxReceiveCount: NATIVE_REDRIVE_MAX_RECEIVE_COUNT,
      }),
    });
    const events = await ensureQueue(sqs, names.events, {});
    return { input, deadLetter, events };
  } finally {
    sqs.destroy();
  }
}

/**
 * Prepares a database and the queues. Idempotent: running it again changes
 * nothing that is already in place.
 */
export async function setup(options: SetupOptions = {}): Promise<SetupResult> {
  const env = options.env ?? process.env;
  const base = loadConfig(env);
  const config = loadConfig({
    ...env,
    DATABASE_URL: withDatabase(base.database.url, options.database),
    DATABASE_OWNER_URL: withDatabase(base.database.ownerUrl, options.database),
    SQS_QUEUE_SUFFIX: options.queueSuffix ?? base.sqs.queueSuffix,
  });

  if (options.database !== undefined) {
    await ensureDatabase(config.database.ownerUrl, options.database);
  }
  await migrate('up', config.database.ownerUrl);
  await ensureAppRole(config.database.ownerUrl, config.database.url);
  const queueUrls = await ensureQueues(config);

  return {
    databaseUrl: config.database.url,
    ownerUrl: config.database.ownerUrl,
    queueUrls,
  };
}

if (import.meta.main) {
  const result = await setup();
  console.log(
    `setup: database ready at ${new URL(result.databaseUrl).pathname.slice(1)}`,
  );
  for (const [role, url] of Object.entries(result.queueUrls)) {
    console.log(`setup: ${role} queue ${url}`);
  }
}
