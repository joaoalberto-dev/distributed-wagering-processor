import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
] as const;

const FAULT_POINT =
  /^(crash-after-commit|crash-after-send|unexpected-on-wallet:[0-9a-f-]{36})$/i;

const flag = z.stringbool().default(true);
const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().nonnegative();

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['production', 'development', 'test'])
      .default('production'),
    PORT: nonNegativeInt.max(65535).default(3000),
    INSTANCE_ID: z.string().min(1).max(64).optional(),
    DATABASE_URL: z
      .url({ protocol: /^postgres(ql)?$/ })
      .default('postgres://wagering_app:wagering_app@localhost:5432/wagering'),
    DATABASE_OWNER_URL: z
      .url({ protocol: /^postgres(ql)?$/ })
      .default(
        'postgres://wagering_owner:wagering_owner@localhost:5432/wagering',
      ),
    DATABASE_POOL_MAX: positiveInt.default(21),
    DB_LOCK_TIMEOUT_MS: positiveInt.default(2000),
    AWS_REGION: z.string().min(1).default('us-east-1'),
    AWS_ENDPOINT_URL: z.url().default('http://localhost:4566'),
    AWS_ACCESS_KEY_ID: z.string().min(1).default('test'),
    AWS_SECRET_ACCESS_KEY: z.string().min(1).default('test'),
    SQS_QUEUE_SUFFIX: z
      .string()
      .regex(/^[A-Za-z0-9_-]*$/)
      .default(''),
    SQS_VISIBILITY_TIMEOUT_SECONDS: positiveInt.max(43200).default(30),
    SQS_BACKOFF_BASE_MS: positiveInt.default(2000),
    SQS_BACKOFF_CAP_MS: positiveInt.default(60000),
    HTTP_BULKHEAD_SIZE: positiveInt.default(11),
    HTTP_BULKHEAD_QUEUE: nonNegativeInt.default(50),
    HTTP_ENABLED: flag,
    SQS_CONSUMER_ENABLED: flag,
    OUTBOX_PUBLISHER_ENABLED: flag,
    REFERENCE_WORKER_ENABLED: flag,
    REFERENCE_TTL_SECONDS: positiveInt.default(86400),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('log'),
    FAULT_INJECTION: z
      .string()
      .optional()
      .transform((value) =>
        (value ?? '')
          .split(',')
          .map((point) => point.trim())
          .filter((point) => point.length > 0),
      )
      .pipe(z.array(z.string().regex(FAULT_POINT, 'unknown fault point'))),
  })
  .refine(
    (env) => env.FAULT_INJECTION.length === 0 || env.NODE_ENV === 'test',
    {
      path: ['FAULT_INJECTION'],
      message: 'FAULT_INJECTION requires NODE_ENV=test',
    },
  )
  .refine((env) => env.SQS_BACKOFF_BASE_MS <= env.SQS_BACKOFF_CAP_MS, {
    path: ['SQS_BACKOFF_BASE_MS'],
    message: 'SQS_BACKOFF_BASE_MS must not exceed SQS_BACKOFF_CAP_MS',
  });

export type LogLevel = (typeof LOG_LEVELS)[number];

export type AppConfig = {
  readonly nodeEnv: 'production' | 'development' | 'test';
  readonly port: number;
  readonly instanceId: string;
  readonly logLevel: LogLevel;
  readonly database: {
    readonly url: string;
    readonly ownerUrl: string;
    readonly poolMax: number;
    readonly lockTimeoutMs: number;
  };
  readonly aws: {
    readonly region: string;
    readonly endpointUrl: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  };
  readonly sqs: {
    readonly queueSuffix: string;
    readonly visibilityTimeoutSeconds: number;
    readonly backoffBaseMs: number;
    readonly backoffCapMs: number;
  };
  readonly http: {
    readonly bulkheadSize: number;
    readonly bulkheadQueue: number;
  };
  readonly roles: {
    readonly http: boolean;
    readonly sqsConsumer: boolean;
    readonly outboxPublisher: boolean;
    readonly referenceWorker: boolean;
  };
  readonly referenceTtlSeconds: number;
  readonly faultInjection: readonly string[];
};

export class InvalidConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n  ${issues.join('\n  ')}`);
    this.name = 'InvalidConfigError';
  }
}

function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (typeof child === 'object' && child !== null) {
      deepFreeze(child as object);
    }
  }
  return Object.freeze(value);
}

/** Parses the environment into a frozen configuration, or throws `InvalidConfigError`. */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  // An empty variable means "use the default", as compose files often set `VAR=`.
  const present = Object.fromEntries(
    Object.entries(env).filter(
      ([, value]) => value !== undefined && value !== '',
    ),
  );
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    throw new InvalidConfigError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join('.')}: ${issue.message}`,
      ),
    );
  }
  const e = parsed.data;
  return deepFreeze({
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    instanceId: e.INSTANCE_ID ?? randomUUID(),
    logLevel: e.LOG_LEVEL,
    database: {
      url: e.DATABASE_URL,
      ownerUrl: e.DATABASE_OWNER_URL,
      poolMax: e.DATABASE_POOL_MAX,
      lockTimeoutMs: e.DB_LOCK_TIMEOUT_MS,
    },
    aws: {
      region: e.AWS_REGION,
      endpointUrl: e.AWS_ENDPOINT_URL,
      accessKeyId: e.AWS_ACCESS_KEY_ID,
      secretAccessKey: e.AWS_SECRET_ACCESS_KEY,
    },
    sqs: {
      queueSuffix: e.SQS_QUEUE_SUFFIX,
      visibilityTimeoutSeconds: e.SQS_VISIBILITY_TIMEOUT_SECONDS,
      backoffBaseMs: e.SQS_BACKOFF_BASE_MS,
      backoffCapMs: e.SQS_BACKOFF_CAP_MS,
    },
    http: {
      bulkheadSize: e.HTTP_BULKHEAD_SIZE,
      bulkheadQueue: e.HTTP_BULKHEAD_QUEUE,
    },
    roles: {
      http: e.HTTP_ENABLED,
      sqsConsumer: e.SQS_CONSUMER_ENABLED,
      outboxPublisher: e.OUTBOX_PUBLISHER_ENABLED,
      referenceWorker: e.REFERENCE_WORKER_ENABLED,
    },
    referenceTtlSeconds: e.REFERENCE_TTL_SECONDS,
    faultInjection: e.FAULT_INJECTION,
  });
}

/** The three queue names, with the suffix inserted before `.fifo`. */
export function queueNames(config: Pick<AppConfig, 'sqs'>): {
  readonly input: string;
  readonly deadLetter: string;
  readonly events: string;
} {
  const suffix = config.sqs.queueSuffix;
  return {
    input: `wager-transactions${suffix}.fifo`,
    deadLetter: `wager-transactions-dlq${suffix}.fifo`,
    events: `wagering-events${suffix}.fifo`,
  };
}
