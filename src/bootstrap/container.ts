import { MikroORM } from '@mikro-orm/postgresql';
import type { Clock } from '../application/ports/clock.js';
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
import type { AppConfig } from '../infrastructure/config/app-config.js';
import { UuidV7Generator } from '../infrastructure/ids/uuid-v7-generator.js';
import {
  enabledLevels,
  JsonLogger,
  NestAppLogger,
} from '../infrastructure/observability/json-logger.js';
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

/** Replacements for in-process tests; anything left out is the production adapter. */
export type ApplicationOverrides = {
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly retryContention?: ContentionRetry;
  readonly timeouts?: Partial<UnitOfWorkTimeouts>;
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
  readonly policies: Policies;
  readonly providerIdentity: ProviderIdentityPort;
  readonly openWallet: OpenWallet;
  readonly reconcileWallet: ReconcileWallet;
  readonly submitWagerTransaction: SubmitWagerTransaction;
  readonly wagerQueries: WagerQueries;
  readonly resolvePendingReferences: ResolvePendingReferences;
  /** Not started here: the workers module starts it when `REFERENCE_WORKER_ENABLED`. */
  readonly referenceWorker: PollingLoop;
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
  );
  const queries = new SqlQueryPort(orm, policies.postgres);
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
    policies,
    providerIdentity,
    openWallet: new OpenWallet(unitOfWork, clock, ids),
    reconcileWallet: new ReconcileWallet(
      unitOfWork,
      metrics,
      appLogger('Reconciliation'),
    ),
    submitWagerTransaction: new SubmitWagerTransaction(
      unitOfWork,
      clock,
      ids,
      metrics,
      appLogger('Wagering'),
      providerIdentity,
      requestContext,
      { referenceTtlMs },
    ),
    wagerQueries: new WagerQueries(queries),
    resolvePendingReferences,
    referenceWorker,
    close: async () => {
      await referenceWorker.stop();
      stopListening();
      await orm.close(true);
    },
  };
}
