import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerMessage } from '../application/messaging/process-wager-message.js';
import {
  OUTBOX_BATCH_SIZE,
  PublishOutbox,
} from '../application/messaging/publish-outbox.js';
import type { Clock } from '../application/ports/clock.js';
import type { EventPublisher } from '../application/ports/event-publisher.js';
import type { IdGenerator } from '../application/ports/id-generator.js';
import type { AppLogger } from '../application/ports/logger.js';
import type { ProviderIdentityPort } from '../application/ports/provider-identity.js';
import type { QueryPort } from '../application/ports/queries.js';
import type { RequestContext } from '../application/ports/request-context.js';
import type { UnitOfWork } from '../application/ports/unit-of-work.js';
import {
  REFERENCE_WORKER_DEFAULTS,
  ResolvePendingReferences,
} from '../application/wagering/resolve-pending-references.js';
import { SubmitWagerTransaction } from '../application/wagering/submit-wager-transaction.js';
import { WagerQueries } from '../application/wagering/wager-queries.js';
import { OpenWallet } from '../application/wallets/open-wallet.js';
import { ReconcileWallet } from '../application/wallets/reconcile-wallet.js';
import { TrustAllProviderIdentity } from '../infrastructure/auth/trust-all-provider-identity.js';
import { SystemClock } from '../infrastructure/clock/system-clock.js';
import {
  type AppConfig,
  queueNames,
} from '../infrastructure/config/app-config.js';
import { FaultInjection } from '../infrastructure/fault-injection.js';
import { UuidV7Generator } from '../infrastructure/ids/uuid-v7-generator.js';
import { createSqsClient } from '../infrastructure/messaging/sqs-client.js';
import { SqsDlqMover } from '../infrastructure/messaging/sqs-dlq-mover.js';
import { SqsEventPublisher } from '../infrastructure/messaging/sqs-event-publisher.js';
import { SqsQueues } from '../infrastructure/messaging/sqs-queues.js';
import {
  SQS_CONSUMER_DEFAULTS,
  SqsWagerConsumer,
} from '../infrastructure/messaging/sqs-wager-consumer.js';
import {
  enabledLevels,
  JsonLogger,
  NestAppLogger,
} from '../infrastructure/observability/json-logger.js';
import {
  DatabaseGauges,
  gaugeSources,
} from '../infrastructure/observability/database-gauges.js';
import { Metrics } from '../infrastructure/observability/metrics.js';
import { AsyncLocalRequestContext } from '../infrastructure/observability/request-context.js';
import { createOrmConfig } from '../infrastructure/persistence/mikro-orm.config.js';
import {
  type ContentionRetry,
  DEFAULT_TIMEOUTS,
  MikroOrmUnitOfWork,
  type UnitOfWorkTimeouts,
} from '../infrastructure/persistence/mikro-orm-unit-of-work.js';
import { PERSISTENCE_RECORDS } from '../infrastructure/persistence/records/index.js';
import { SqlQueryPort } from '../infrastructure/persistence/sql-query-port.js';
import { PollingLoop } from '../infrastructure/polling/polling-loop.js';
import {
  createPolicies,
  listenToPolicies,
  type Policies,
} from '../infrastructure/resilience/policies.js';

/** The pending-reference worker's wait when a cycle found nothing (tuning table). */
const REFERENCE_WORKER_IDLE_POLL_MS = 500;

/** The outbox publisher's wait after a cycle that claimed less than a full batch (tuning table). */
const OUTBOX_PUBLISHER_IDLE_POLL_MS = 500;

/** Replacements for in-process tests; anything left out is the production adapter. */
export type ApplicationOverrides = {
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly retryContention?: ContentionRetry;
  readonly timeouts?: Partial<UnitOfWorkTimeouts>;
  readonly faults?: FaultInjection;
  /** Wraps the SQS event publisher, to fail chosen entries or record calls. */
  readonly wrapEventPublisher?: (publisher: EventPublisher) => EventPublisher;
};

/** The application graph: every port adapter and use case, built without Nest. */
export type Application = {
  readonly config: AppConfig;
  readonly orm: MikroORM;
  readonly unitOfWork: UnitOfWork;
  readonly queries: QueryPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly requestContext: RequestContext;
  readonly logger: JsonLogger;
  readonly metrics: Metrics;
  /** Refreshed by each `/metrics` scrape. */
  readonly gauges: DatabaseGauges;
  readonly policies: Policies;
  readonly providerIdentity: ProviderIdentityPort;
  readonly openWallet: OpenWallet;
  readonly reconcileWallet: ReconcileWallet;
  readonly submitWagerTransaction: SubmitWagerTransaction;
  readonly wagerQueries: WagerQueries;
  readonly resolvePendingReferences: ResolvePendingReferences;
  /** Not started here: the workers module starts it when `REFERENCE_WORKER_ENABLED`. */
  readonly referenceWorker: PollingLoop;
  readonly sqs: SQSClient;
  readonly queues: SqsQueues;
  readonly processWagerMessage: ProcessWagerMessage;
  /** Not started here: the messaging module starts it when `SQS_CONSUMER_ENABLED`. */
  readonly sqsConsumer: SqsWagerConsumer;
  readonly publishOutbox: PublishOutbox;
  /** Not started here: the workers module starts it when `OUTBOX_PUBLISHER_ENABLED`. */
  readonly outboxPublisher: PollingLoop;
  close(): Promise<void>;
};

/**
 * Builds the application graph. Nest modules only expose what it returns,
 * and in-process tests build the same graph with failing adapters.
 */
export async function buildApplication(
  config: AppConfig,
  overrides: ApplicationOverrides = {},
): Promise<Application> {
  const requestContext = new AsyncLocalRequestContext({
    instanceId: config.instanceId,
  });
  const logger = new JsonLogger(requestContext, enabledLevels(config.logLevel));
  const appLogger = (context: string): AppLogger =>
    new NestAppLogger(logger, context);
  const metrics = new Metrics();
  const policies = createPolicies(config);
  const stopListening = listenToPolicies(metrics);

  const orm = await MikroORM.init(createOrmConfig(config, PERSISTENCE_RECORDS));
  const unitOfWork = new MikroOrmUnitOfWork(
    orm,
    {
      ...DEFAULT_TIMEOUTS,
      lockTimeoutMs: config.database.lockTimeoutMs,
      ...overrides.timeouts,
    },
    overrides.retryContention ?? policies.httpContentionRetry,
    policies.postgres,
    metrics,
  );
  const queries = new SqlQueryPort(orm, policies.postgres, metrics);
  const clock = overrides.clock ?? new SystemClock();
  const ids = overrides.ids ?? new UuidV7Generator();
  const providerIdentity = new TrustAllProviderIdentity(
    appLogger('Authentication'),
  );
  const referenceTtlMs = config.referenceTtlSeconds * 1000;
  const workerLogger = appLogger('ReferenceWorker');
  const resolvePendingReferences = new ResolvePendingReferences(
    unitOfWork,
    clock,
    ids,
    metrics,
    workerLogger,
    requestContext,
    { ...REFERENCE_WORKER_DEFAULTS, referenceTtlMs },
  );
  const referenceWorker = new PollingLoop({
    cycle: () => resolvePendingReferences.runCycle(),
    idlePollMs: REFERENCE_WORKER_IDLE_POLL_MS,
    circuits: [policies.circuits.postgres],
    onError: (error) =>
      workerLogger.warn('reference worker cycle failed', {
        reason: error instanceof Error ? error.name : 'unknown',
      }),
  });

  const submitWagerTransaction = new SubmitWagerTransaction(
    unitOfWork,
    clock,
    ids,
    metrics,
    appLogger('Wagering'),
    providerIdentity,
    requestContext,
    { referenceTtlMs },
  );

  const faults = overrides.faults ?? new FaultInjection(config.faultInjection);
  const sqs = createSqsClient(config);
  const queues = new SqsQueues(sqs, policies.sqs, queueNames(config));
  const consumerLogger = appLogger('SqsConsumer');
  const processWagerMessage = new ProcessWagerMessage(
    faults.wrapSubmitter(submitWagerTransaction),
    metrics,
    consumerLogger,
    requestContext,
  );
  const sqsConsumer = new SqsWagerConsumer({
    sqs,
    guard: policies.sqs,
    queues,
    process: processWagerMessage,
    dlq: new SqsDlqMover({
      sqs,
      guard: policies.sqs,
      queues,
      instanceId: config.instanceId,
      onMoved: (reason) => metrics.sqsDlqMove(reason),
    }),
    metrics,
    logger: consumerLogger,
    context: requestContext,
    faults,
    circuits: [policies.circuits.postgres, policies.circuits.sqs],
    settings: {
      ...SQS_CONSUMER_DEFAULTS,
      visibilityTimeoutSeconds: config.sqs.visibilityTimeoutSeconds,
      backoff: {
        baseMs: config.sqs.backoffBaseMs,
        capMs: config.sqs.backoffCapMs,
      },
    },
  });

  // One attempt per send: the outbox counts and schedules its own retries.
  const eventsSqs = createSqsClient(config, { maxAttempts: 1 });
  const sqsEventPublisher = new SqsEventPublisher({
    sqs: eventsSqs,
    guard: policies.sqs,
    queues,
    faults,
  });
  const publisherLogger = appLogger('OutboxPublisher');
  const publishOutbox = new PublishOutbox(
    unitOfWork,
    overrides.wrapEventPublisher?.(sqsEventPublisher) ?? sqsEventPublisher,
    clock,
    metrics,
    publisherLogger,
  );
  const outboxPublisher = new PollingLoop({
    // Only a full batch suggests more is due; otherwise wait the idle poll.
    cycle: async () =>
      (await publishOutbox.runCycle()) >= OUTBOX_BATCH_SIZE ? 1 : 0,
    idlePollMs: OUTBOX_PUBLISHER_IDLE_POLL_MS,
    circuits: [policies.circuits.postgres, policies.circuits.sqs],
    onError: (error) =>
      publisherLogger.warn('outbox publish cycle failed', {
        reason: error instanceof Error ? error.name : 'unknown',
      }),
  });

  const gauges = new DatabaseGauges({
    sources: gaugeSources(orm, sqs, queues),
    registry: metrics.registry,
    readShared: config.roles.outboxPublisher || config.roles.referenceWorker,
  });

  return {
    config,
    orm,
    unitOfWork,
    queries,
    clock,
    ids,
    requestContext,
    logger,
    metrics,
    gauges,
    policies,
    providerIdentity,
    openWallet: new OpenWallet(unitOfWork, clock, ids),
    reconcileWallet: new ReconcileWallet(
      unitOfWork,
      metrics,
      appLogger('Reconciliation'),
    ),
    submitWagerTransaction,
    wagerQueries: new WagerQueries(queries),
    resolvePendingReferences,
    referenceWorker,
    sqs,
    queues,
    processWagerMessage,
    sqsConsumer,
    publishOutbox,
    outboxPublisher,
    close: async () => {
      await sqsConsumer.stop();
      await referenceWorker.stop();
      await outboxPublisher.stop();
      stopListening();
      sqs.destroy();
      eventsSqs.destroy();
      await orm.close(true);
    },
  };
}
