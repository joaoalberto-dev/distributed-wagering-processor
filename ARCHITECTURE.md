# Architecture

This document describes the Distributed Wagering Processor: what it guarantees, how, and at what cost. The main body describes the current design, organized by the evaluation areas of the challenge. Appendix A keeps the decision log in chronological order, including decisions that were later replaced.

*   **Status:** design complete; implementation follows the tasks on the [project board](https://github.com/users/joaoalberto-dev/projects/3). Each task updates the section it touches and appends to the decision log. Where code and this document disagree, the disagreement is a bug in one of them.
*   **Detail:** the full design, with port signatures, the schema specification, the metric table, the test harness, and the rejected alternatives (A1–A42), is in [`docs/designs/distributed-wagering-processor.md`](docs/designs/distributed-wagering-processor.md). That document is frozen; this one is canonical.
*   **Conventions:** "challenge §N" refers to a section of [`CHALLENGE.md`](CHALLENGE.md). Money amounts are decimal strings with two places.

## Contents

1.  [System overview](#1-system-overview)
2.  [Financial correctness](#2-financial-correctness)
3.  [Concurrency](#3-concurrency)
4.  [Idempotency](#4-idempotency)
5.  [Messaging and failure recovery](#5-messaging-and-failure-recovery)
6.  [Modeling and architecture](#6-modeling-and-architecture)
7.  [Tests](#7-tests)
8.  [Observability](#8-observability)
9.  [HTTP contract and failure codes](#9-http-contract-and-failure-codes)
10. [Interpretations of the challenge](#10-interpretations-of-the-challenge)
11. [Risks, limitations, and non-goals](#11-risks-limitations-and-non-goals)
12. [Appendix A: decision log](#appendix-a-decision-log)

## 1. System overview

Game providers report wagering operations (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) over HTTP and through an SQS FIFO queue. The service applies each operation to the player's wallet exactly once, records every balance change in an append-only ledger, and publishes integration events through a transactional outbox.

```text
                 HTTP (Idempotency-Key)                        SQS FIFO
 Game provider ───────────────────────┐        ┌──────── wager-transactions.fifo ◄── Game provider
                                      ▼        ▼                    │ (redrive backstop)
                        ┌──────────────────────────────┐            ▼
                        │  app instance (×3, one image)│   wager-transactions-dlq.fifo
                        │  ─ HTTP API                  │
                        │  ─ SQS consumer              │
                        │  ─ outbox publisher          │──────► wagering-events.fifo ──► event consumers
                        │  ─ pending-reference worker  │
                        └──────────────┬───────────────┘
                                       │ one SQL transaction per operation
                                       ▼
                        ┌──────────────────────────────┐
                        │ PostgreSQL 17                │
                        │ wallets · wager_transactions │
                        │ wallet_ledger_entries        │
                        │ inbox · outbox               │
                        └──────────────────────────────┘
```

*   **One source of truth.** PostgreSQL holds every guarantee. The queues are delivery channels; they guarantee nothing about consistency.
*   **Identical instances.** Every instance runs every role by default (HTTP, consumer, publisher, worker), selected by environment flags. Instances share no memory and coordinate only through row locks, unique constraints, and `SKIP LOCKED`.
*   **Stack.** Bun runtime, NestJS 12 on Express, MikroORM 7 with PostgreSQL 17, SQS through MiniStack (an SQS emulator that runs locally with no account), Zod for validation, `@nestjs/resilience` for retries, bulkheads, and circuit breakers.

## 2. Financial correctness

### Money

*   **Representation.** `Money` holds BigInt minor units (cents) and an ISO-4217 currency. It is immutable, and arithmetic across currencies throws. JavaScript `number` is never used for money. BigInt never leaves the domain: responses, events, and persistence carry the decimal string (`MoneyProps`).
*   **Strict parsing.** `Money.from` accepts only `^-?(0|[1-9][0-9]{0,17})\.[0-9]{2}$`. It rejects NaN, Infinity, exponents, missing or extra decimals, leading zeros, a leading `+`, `-0.00`, and whitespace. Nothing is rounded or normalized.
*   **Layered limits.**
    *   `Money` itself may be negative or large (needed by `negate()` and by reconciliation of corrupt data).
    *   The input contract adds "non-negative" and the ceiling `999,999,999,999.99` (`^(0|[1-9][0-9]{0,11})\.[0-9]{2}$`).
    *   `Wallet` keeps every balance between 0 and the ceiling.
*   **Storage.** Every money column is `NUMERIC(14,2)`, whose capacity equals the ceiling. The column bounds magnitude but rounds extra decimals on a direct SQL write, so the domain parser is the guard for scale.

### Wallet and ledger

*   A wallet's `version` starts at 1 and increases only when the balance changes.
*   A positive opening balance creates an internal `OPENING` transaction and its `CREDIT` entry in the same SQL transaction. A zero opening creates neither.
*   Each balance change writes one `WalletLedgerEntry` with `direction`, `amount`, `balanceBefore`, `balanceAfter`, and `walletVersion` (the wallet's version after the entry). Entries are never updated or deleted.

| Kind | Effect |
|---|---|
| `BET` | debit |
| `WIN`, `REFUND`, `OPENING` | credit |
| `ROLLBACK` | the inverse of its reference's entry |
| `LOSS` | nothing: no entry, no balance or version change |

### Guarantees enforced by the schema

The application connects as `wagering_app`, which has only `SELECT`, `INSERT`, and `UPDATE`. Migrations run as `wagering_owner`. Grants and triggers are two independent barriers.

*   **Rows.** `CHECK (balance >= 0)` and `CHECK (balance_after >= 0)`; amount sign per kind; status and kind values; `status <> 'PENDING'` (the pending state exists only in memory).
*   **Identities.** `UNIQUE (provider_id, idempotency_key)` and `UNIQUE (provider_id, external_transaction_id)`.
*   **Same-wallet references.** Composite foreign keys `(reference_transaction_id, wallet_id)` and ledger `(transaction_id, wallet_id)` put "same wallet" in the schema.
*   **One successful reversal.** A partial unique index on `reference_transaction_id` where the status is `PROCESSED` and the kind is `REFUND` or `ROLLBACK`.
*   **Immutability.** Triggers block `UPDATE`, `DELETE`, and `TRUNCATE` on the ledger; changes to identity columns; and any change to a terminal transaction. A trigger allows only the persisted lifecycle edges.
*   **Ledger arithmetic.** `balance_after = balance_before ± amount` by direction, per row.
*   **Named violations.** Every trigger raises SQLSTATE `23000` and reports its own name as the constraint, so a refused write names its rule the way a `CHECK` does. Row triggers run before `CHECK` constraints, so the lifecycle trigger refuses a `PENDING` insert first; the status checks stay as a second barrier for writes that bypass triggers.
*   **Commit-time consistency.** Deferred constraint triggers check at `COMMIT`:
    *   **tip:** each touched wallet's balance and version equal its latest entry's `balance_after` and `wallet_version` (0 and 1 with no entries);
    *   **chain:** each new entry continues the previous one (`balance_before` equals the previous `balance_after`, versions without gaps);
    *   **transaction:** each new entry belongs to a `PROCESSED` transaction of a balance-moving kind, with the same amount and currency;
    *   **direction:** the entry's direction matches the kind; a `ROLLBACK` is the opposite of its reference's entry;
    *   **entry:** each transaction that becomes `PROCESSED` with a balance-moving kind has its ledger entry, so an operation cannot be recorded as applied without moving the balance.

    With the tip and the chain checked at every commit, "stored balance = sum of the ledger" holds by induction for every write that goes through the triggers, including manual SQL as `wagering_app`.

### Business rules

The first failing check decides the outcome. HTTP and SQS run the full list; the pending-reference worker re-runs the domain checks.

1.  **Input contract (V1–V7), `400 VALIDATION_FAILED`, not persisted.** Strict schemas (unknown fields rejected); ID formats; amount grammar, sign, and ceiling; `kind` is not `OPENING`; reference required for `REFUND` and `ROLLBACK`, optional for `WIN` and `LOSS`, forbidden for `BET`; positive amounts except `LOSS` (any non-negative, informational); no self-reference.
2.  **Identity, `409`, not persisted.** See [Idempotency](#4-idempotency).
3.  **Domain checks under the wallet lock (D1–D11), `422`, persisted and final for that external ID.**
    *   D1 wallet exists (else `404`, not persisted); D2 wallet belongs to the player; D3 same currency.
    *   D4 reference resolved by `(providerId, referenceExternalTransactionId)`; absent → wait as `PENDING_REFERENCE`.
    *   D5 same player, wallet, currency, and round (`details.field` names the first difference); D6 allowed reference kind (`WIN`/`LOSS`/`REFUND` → `BET`; `ROLLBACK` → `BET`, `WIN`, `REFUND`); D7 reversal amount equals the reference amount; D8 reference status (pending → wait; rejected or failed → `REFERENCE_NOT_PROCESSED`).
    *   D9 at most one successful reversal per transaction, across `REFUND` and `ROLLBACK` (`REFERENCE_ALREADY_REVERSED`, with `details.referenceReversedBy` naming the reversal that already succeeded).
    *   D10 funds (`INSUFFICIENT_FUNDS`; `REVERSAL_INSUFFICIENT_FUNDS` for a `ROLLBACK` debit); D11 ceiling (`BALANCE_LIMIT_EXCEEDED`).

A round may have several `WIN`s, and a processed `REFUND` may itself be rolled back. A `WIN` or `LOSS` against a `BET` is processed whatever the arrival order of a reversal of that `BET` (see §10). It is flagged with `details.referenceReversedBy` when the reversal was already processed at the time it is decided; a `WIN` or `LOSS` decided first stays unflagged, and the later reversal is processed normally.

### Reconciliation

`POST /wallets/:walletId/reconciliation` runs SQL aggregates in one `REPEATABLE READ READ ONLY` transaction, without locks and without loading entries into memory. The response has the challenge's fields plus `issues`:

```json
{
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "storedBalance": { "amount": "975.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "975.00", "currency": "BRL" },
  "difference": { "amount": "0.00", "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 42,
  "issues": []
}
```

*   `difference = stored − calculated`, signed. `consistent` is true only when `issues` is empty.
*   Issues: `BALANCE_MISMATCH`; and, as a later addition, `VERSION_MISMATCH`, `CHAIN_GAP`, and `CHAIN_BREAK`.
*   A divergence is logged (IDs and issue codes, no amounts) and counted in `reconciliation_divergences_total{issue}`. Data is never corrected.
*   The commit-time triggers already keep every normal write consistent, so reconciliation exists for writes that bypass them: a superuser, `session_replication_role = replica`, or a partial restore.

## 3. Concurrency

*   **Per-wallet pessimistic lock.** Each operation runs in one SQL transaction that takes `SELECT … FOR UPDATE` on its wallet row and then re-reads everything it decides on: the idempotency key, the external ID, the reference, and any existing reversal. No decision uses data read before the lock.
*   **Why not optimistic locking or a conditional `UPDATE`.**
    *   Optimistic locking makes every conflicting writer on a hot wallet redo the whole decision, and its retry budget turns contention into failures.
    *   A conditional `UPDATE … WHERE balance >= x` cannot express decisions that read other rows (reversal allowance, reference state, ledger chain).
    *   A global or session-level advisory lock serializes unrelated work or survives rollbacks.
*   **Lock-order invariant.**
    *   Every lock taken after the wallet lock is on that wallet's rows or on a newly inserted row.
    *   The inbox key wait happens before the wallet lock.
    *   So no lock cycle can form. A deadlock (`40P01`) is still classified as contention as a safety net.
*   **Contention is bounded.** `lock_timeout` 2 s, `statement_timeout` 5 s, `transaction_timeout` 10 s. On HTTP a contention error is retried up to twice in process with jitter, then answered with `503` and `Retry-After`. Duplicate requests that arrive together wait for the lock and then receive the stored result's replay.
*   **Hot wallet.**
    *   Writes to one wallet are serialized. That is the correctness mechanism, and it caps one wallet's throughput.
    *   Each instance has 20 connections, split into fixed shares: HTTP 11 (a bulkhead with a bounded queue of 50 and a 2 s wait); consumer 4; worker 1; publisher 1; reconciliation 2; readiness and gauges 1.
    *   A burst on one wallet can take the whole HTTP share of an instance, but never the connections of the other roles.
    *   Contention never opens a circuit breaker.
*   **Multiple instances.**
    *   The pending-reference worker selects due rows from a random offset and locks wallets with `SKIP LOCKED`. A busy wallet's row is pushed back by 1 s without counting an attempt.
    *   A re-check of the due time with `clock_timestamp()` under the lock gives one attempt per backoff window across all instances, with no lease column.
    *   Publishers take disjoint batches with `FOR UPDATE SKIP LOCKED`.
*   **One clock for scheduling.** Due times and TTLs use the database clock only, so instances with skewed clocks agree on what is due.

## 4. Idempotency

*   **Three independent identities.**

    | Identity | What it identifies |
    |---|---|
    | `(providerId, idempotencyKey)` | a repeated request |
    | `(providerId, externalTransactionId)` | the financial operation |
    | `(consumerName, envelope messageId)` | an SQS delivery (inbox) |

*   **Decision table.** The use case reads by key, then by external ID, first without a lock and again under the wallet lock. The table is applied to the row found, so a row found by external ID that carries the incoming key follows the key rows: without the lock, another request can commit between the two reads.

    | Key | Stored hash vs incoming | External ID | Result |
    |---|---|---|---|
    | found | equal | — | replay of the stored result, `idempotentReplay: true` |
    | found | different | — | `409 IDEMPOTENCY_KEY_CONFLICT` |
    | not found | — | found under another key | `409 EXTERNAL_TRANSACTION_ID_CONFLICT`, even with an identical payload |
    | not found | — | not found | proceed to the domain checks |

*   **A terminal result is final for its external ID.** A provider that wants to try again (for example after `INSUFFICIENT_FUNDS`) sends a new external ID. Otherwise one operation could move money twice.
*   **Payload hash.**
    *   Fields: the validated `{providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId?}`. The key, headers, and envelope are excluded, so the same operation sent over HTTP and then over SQS with the same key is a replay.
    *   Algorithm: strict validation; absent optional fields omitted and an explicit `null` rejected; RFC 8785 canonical JSON (every value is a string, so a recursive key sort and `JSON.stringify`); SHA-256; stored as `v1:<hex>`. Fixed test vectors pin it.
*   **Replay semantics.**
    *   The status comes from the stored state: `PROCESSED` → 200, `PENDING_REFERENCE` → 202 with `Location`, `REJECTED` and `FAILED` → 422.
    *   A replay returns the same `transactionId`, `status`, `balance` snapshot, `failureCode`, and `details` as the original; only `idempotentReplay` differs.
    *   An operation that started pending replays its terminal result once the worker decides it. A replay of a pending row is read-only.
*   **Persistent, never in memory.** All three identities are unique constraints in PostgreSQL, written in the same transaction as the effect. A unique violation on an identity means another request committed first: the use case rolls back, re-reads once, and applies the decision table.

## 5. Messaging and failure recovery

### SQS consumption

*   **Same use case as HTTP.** The message is `{messageId, type: "WagerTransactionRequested", occurredAt, data}`, where `data` is the HTTP body plus `idempotencyKey` (challenge §10).
    *   The adapter (`SqsWagerConsumer`) validates the envelope with the shared Zod schemas; an invalid one goes to the DLQ as `VALIDATION_FAILED` without reaching the application.
    *   `ProcessWagerMessage` calls `SubmitWagerTransaction` with the delivery `(wager-transactions-consumer, messageId)` and maps the result or error to an outcome: ack, DLQ with a permanent reason, or retry with an error class. The adapter decides a retry from `ApproximateReceiveCount`.
*   **Inbox first.**
    *   The consumer looks up `(consumerName, messageId)`: the same `(payload_hash, idempotency_key)` pair is acknowledged as a duplicate, and a different pair goes to the DLQ as `MESSAGE_ID_CONFLICT`.
    *   For a new message, the transaction ID is generated first. The inbox row is inserted with it before the wallet lock, and its foreign key is checked at commit.
    *   If the re-read under the lock finds the operation already stored by another channel, the transaction rolls back, and a short transaction records the inbox row with the existing ID.
*   **Acknowledge only after commit.** The inbox row commits with the effect, so a redelivery after a crash is a duplicate with no second effect.
*   **Ordering.**
    *   A receive asks for at most the free group slots (4).
    *   Messages of one `MessageGroupId` run one after another in SQS order, and groups run in parallel.
    *   The consumer extends a waiting message's visibility before starting it.
    *   When a message is backed off, the rest of its group is released to the queue so SQS redelivers the group in order. After a DLQ move, the rest of the group continues.
*   **Error classes and budgets.**

    | Class | Examples | HTTP | SQS |
    |---|---|---|---|
    | Contention | lock, statement, or transaction timeout; serialization failure; pool-acquire timeout | ≤ 2 retries, then 503 | visibility backoff `min(2^(n−1) · 2 s, 60 s)`; DLQ on the 10th receive |
    | Outage | connection errors, SQS network or 5xx | 503 | backoff; loops skip cycles while the circuit is open; DLQ on the 10th receive |
    | Business | domain rejection, identity conflict | 422 / 409 | ack, or DLQ for permanent errors |
    | Unexpected | anything else | 500 | backoff; DLQ on the 3rd receive |

    *   The backoff is the message's new visibility timeout, rounded up to whole seconds, without jitter: the group is blocked while it waits, so jitter would spread no load.
    *   An SQS call with no HTTP answer, a 5xx, or throttling is an `sqs` outage; any other 4xx leaves unchanged and counts as unexpected. The consumer receives nothing while the `postgres` or the `sqs` circuit is open.

*   **One DLQ path.**
    *   The application moves a message itself: it sends the body unchanged to the DLQ with the original group, a deduplication ID (the envelope `messageId`, or the SQS `MessageId` for an invalid envelope), and the attributes `failureReason`, `receiveCount`, `instanceId`, and `errorClass` (`contention`, `outage`, `unexpected`, or `permanent`), then deletes the original.
    *   A failed delete, visibility change, or DLQ move is logged and left to the visibility timeout: the message comes back as an inbox duplicate, or is moved again and dropped by the DLQ's deduplication window.
    *   Native redrive at 50 receives is only a backstop for processes that die before classifying.
*   **Redrive procedure.** Messages whose `failureReason` is `RETRY_BUDGET_EXHAUSTED`, or `UNEXPECTED_ERROR` after its cause is fixed, can be moved back to the input queue unchanged; the inbox and the identities make that safe. Permanent reasons (`VALIDATION_FAILED`, identity conflicts, `MESSAGE_ID_CONFLICT`, `WALLET_NOT_FOUND`) are not redriven.

### Transactional outbox

*   **Atomicity.** Events are written to `outbox` in the same transaction as the transaction row, the wallet, the ledger entry, and the inbox row. Nothing is published before commit.
*   **Publishing cycle.** One short transaction selects up to 10 due rows with `FOR UPDATE SKIP LOCKED`, sends them with `SendMessageBatch` inside that transaction, and records each entry with the domain `OutboxMessage` (`markPublished`, or `scheduleRetry` with backoff). A trigger makes `published_at` write-once.
*   **Crash safety.** A crash during the send releases the row locks at once, and another instance republishes the same `eventId`. A commit that fails after a successful send also leads to a republish. Both duplicates are safe: consumers de-duplicate by `eventId`, and the FIFO deduplication window absorbs most of them.
*   **No dead-letter state.** An event records an outcome that is already committed, so it is retried forever (backoff capped at 5 minutes). `outbox_lag_seconds` and `outbox_sender_faults_total` expose a stuck event.
*   **Destination.** `wagering-events.fifo`, `MessageGroupId = wallet_id`, `MessageDeduplicationId = eventId`.

| Event (v1) | When |
|---|---|
| `WagerTransactionProcessed` | any `PROCESSED`, including `LOSS` and `OPENING` |
| `WalletBalanceChanged` | only when the balance moves; `data` as in challenge §11, with `walletVersion` |
| `WagerTransactionRejected` | any `REJECTED`, including reference TTL expiry |
| `WagerTransactionPendingReference` | on entering `PENDING_REFERENCE`, once |
| `WagerTransactionFailed` | on `FAILED` (added to the challenge's minimum set) |

The envelope is an abstract `IntegrationEvent<T>` with one subclass per event, carrying `eventId`, `aggregateId`, `correlationId`, `causationId`, `occurredAt`, `version`, and `data` with money as `MoneyProps`. A replay emits nothing.

### Out-of-order references

*   A `REFUND` or `ROLLBACK` whose reference has not arrived is stored as `PENDING_REFERENCE` (`202`), and a `WagerTransactionPendingReference` event is published.
*   **Wake-up.** When a `BET`, `WIN`, or `REFUND` becomes terminal, the same transaction sets the due time of its pending dependents to now. Nothing cascades inline, so the lock stays short; the worker applies them on its next cycle (at most about 1 s when idle).
*   **Backoff and TTL.** Attempts back off from 1 s to 5 minutes. After 24 hours (configurable), the worker decides once more: an absent reference gives `REFERENCE_NOT_FOUND` and a still-pending one gives `REFERENCE_NOT_READY`.
*   **`FAILED`.** If that final attempt throws an unexpected error, the row becomes `FAILED` with `PROCESSING_FAILED`, written by the same persistence step as every other outcome. Transient errors never cause `FAILED`.
*   **Other errors.** Contention skips the row, which stays due and uncounted. An outage ends the cycle, and the polling loop waits while the `postgres` circuit is open. An unexpected error before the TTL counts the attempt and reschedules the row.

### Crash, outage, and shutdown

*   **Killed after commit, before ack.** The message is redelivered after the visibility timeout; a survivor finds the inbox row and acknowledges it as a duplicate.
*   **SQS or PostgreSQL outage.**
    *   Each dependency has a circuit breaker that counts only Outage errors.
    *   While it is open, the polling loops that need it skip their cycles. Messages are not received, so retry budgets are not consumed.
    *   After the open period, the next normal cycle is the probe. HTTP keeps committing during an SQS outage, and the outbox backlog drains afterwards.
*   **Restart.** All state lives in PostgreSQL and the queues. After a restart, pending references, unpublished events, and in-flight messages are picked up by whichever instance runs first.
*   **`SIGTERM`.**
    1.  The consumer stops polling, finishes the message in progress in each group within 20 s, and releases the unstarted ones with visibility 0.
    2.  The publisher and the worker finish their current cycle.
    3.  Readiness returns 503 while HTTP drains.

## 6. Modeling and architecture

*   **Layers.**

    ```text
    domain  ◄──  application  ◄──  infrastructure ──►  contracts
                      ▲                                    ▲
                      └──────────  interface  ─────────────┘
    bootstrap imports everything and wires it
    ```

    *   **`src/domain`:** `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, the integration events, and `settle()`. It has no NestJS, ORM, or validation imports.
    *   **`src/application`:** use cases and ports. It has no Nest decorators.
    *   **`src/contracts`:** Zod schemas for the inbound payloads.
    *   **`src/infrastructure`:** MikroORM, SQS, observability, and the SQS consumer as an inbound adapter.
    *   **`src/interface`:** HTTP controllers.

    `oxlint` (`no-restricted-imports` per folder, plus `import/no-cycle`) enforces the rule.
*   **Aggregates with private constructors.** Each aggregate has a creation factory (`Wallet.open`, `WagerTransaction.create`, `WagerTransaction.open` for the internal `OPENING`, `WalletLedgerEntry.create`, and so on) and `rehydrate` for persisted state. Invariants live in the classes, not in services.
*   **One decision function.** `settle()` is pure: it reads the transaction, the wallet, the reference, and any existing reversal, and returns `process` (with an effect or none), `reject`, or `wait`. HTTP, SQS, and the worker all call it. One persistence step applies the result, writing the transaction, the wallet, the ledger entry, the outbox events, and the wake-up.
*   **Lifecycle.**
    *   `PENDING` exists only in memory.
    *   The persisted edges are: insert as `PROCESSED`, `REJECTED`, or `PENDING_REFERENCE`; then `PENDING_REFERENCE` to itself, `PROCESSED`, `REJECTED`, or `FAILED`.
    *   Terminal rows never change.
*   **Ports.** `UnitOfWork`; the repositories for wallets, transactions, ledger, inbox, and outbox; `ReconciliationReader`; `QueryPort`; `EventPublisher`; `ProviderIdentityPort`; `Clock`; `IdGenerator`; `Telemetry`; `RequestContext`; `AppLogger`.
*   **Composition.** `buildApplication(config)` in `src/bootstrap/container.ts` builds every adapter, policy, and use case without Nest; the Nest modules only expose what it returns, and in-process tests build the same graph. The container owns the one MikroORM instance and its pool; `PersistenceModule` closes it on shutdown.
*   **Resilience wiring.** The `postgres` circuit wraps each unit-of-work attempt and each read of `QueryPort`; an open circuit fails fast as an Outage (`503`). The HTTP contention retry wraps the whole attempt from outside, so it never retries a call the circuit refused. Bulkheads are applied by a global interceptor in `src/bootstrap`, keyed by handler: reconciliation, readiness and `/metrics`, and every other business route; liveness has none.
*   **MikroORM usage.**
    *   Persistence records (`defineEntity`, no decorators) are separate from the domain classes, with explicit mappers, because ORM hydration would bypass `rehydrate`.
    *   Each operation uses the entity manager of its own `em.transactional()` call, with one ordered `flush` at commit (`FlushMode.COMMIT`, so a query never flushes early); the global context is disabled. State is loaded after the lock, with `refresh`.
    *   Records declare their foreign keys as many-to-one relations mapped to the plain ID, only so the flush inserts the wallet, then the transaction, then the entry.
    *   `concurrencyCheck` on the transaction status guards worker transitions.
    *   `version: true` is not used, because the wallet version is a domain rule.
    *   Raw SQL is used only where nothing is loaded: the inbox insert, the outbox claim, the wake-up, the worker's scheduling updates, and the reconciliation aggregates.
*   **Authentication (designed, not implemented).**
    *   The challenge awards no points for it.
    *   The target design is Keycloak with OAuth2 client credentials. The token carries `provider_id`, and a body `providerId` that differs from the token's gets `403 PROVIDER_MISMATCH`.
    *   The code has one extension point, `ProviderIdentityPort`. Its current adapter accepts any well-formed `providerId` and logs a warning at startup.

## 7. Tests

| Layer | Location | Infrastructure | Covers |
|---|---|---|---|
| Unit | `src/**/*.spec.ts` | none | `Money`, `Wallet`, the lifecycle, `settle()` for every kind and check, ledger arithmetic, hash vectors, schemas |
| Integration | `test/integration/` | real PostgreSQL and MiniStack | migrations up, down, and up; every constraint and trigger violated by direct SQL; atomicity under injected failure; inbox and redelivery; DLQ classification; per-group ordering; partial batch failure; reconciliation; multi-worker backoff; SIGTERM drain |
| Concurrency | `test/concurrency/` | the same, plus three or more processes started with `Bun.spawn` | the eight scenarios of challenge §13, plus a hot wallet, a long SQS outage, reconciliation during writes, and credits near the ceiling |

*   **No mocks of PostgreSQL or SQS** in integration and concurrency tests. Missing infrastructure fails the run instead of skipping it.
*   **Isolation.** Tests use their own database (`wagering_test`) and their own queues per spec file, so running containers of the `app` profile never touch test data.
*   **Outages** are simulated with a TCP proxy between each spawned process and PostgreSQL or MiniStack. Crash points (`crash-after-commit`, `crash-after-send`) exist only under `NODE_ENV=test`.
*   **Determinism.**
    *   Tests wait on conditions with explicit timeouts, never on sleeps.
    *   They assert distinct PIDs.
    *   Clients retry `503` with the same key.
    *   Every financial scenario ends by reconciling every wallet it touched.
*   The test matrix (scenario, channel, processes, fault point, assertions) and the requirement-to-test table are added here when the tests land (task 13).

## 8. Observability

*   **Logs.** JSON through a `ConsoleLogger` subclass. An `AsyncLocalStorage` context adds `correlationId`, `requestId`, `messageId`, `sqsMessageId`, `transactionId`, `walletId`, `providerId`, and `instanceId`. Amounts, balances, and payloads are never logged.
*   **Metrics.** Prometheus format at `/metrics`, through `prom-client`:

    | Required category | Metrics |
    |---|---|
    | transactions by status | `wager_transactions_total{kind,status,channel}` |
    | duplicates | `idempotent_replays_total`, `inbox_duplicates_total`, `idempotency_conflicts_total`, `message_id_conflicts_total` |
    | retries | `sqs_retries_total`, `reference_attempts_total`, `outbox_publish_attempts_total` |
    | DLQ | `sqs_dlq_moves_total{reason}`, `sqs_dlq_depth` |
    | lock conflicts | `wallet_lock_wait_seconds`, `wallet_lock_timeouts_total`, `statement_timeouts_total`, `unique_violation_retries_total` |
    | outbox lag | `outbox_lag_seconds`, `outbox_pending`, `outbox_sender_faults_total` |
    | latency | `wager_processing_duration_seconds` |

    Also: `pending_references`, `reference_failed_total`, `reconciliation_divergences_total`, `bulkhead_rejections_total`, `circuit_state`, and pool gauges.
*   **Health.** `/health/live` checks only the process. `/health/ready` checks PostgreSQL, SQS, and that the latest migration is applied, each with a 1 s timeout. It returns 503 while draining, naming the failing dependency. Neither requires authentication.
    *   The expected migration is `LATEST_MIGRATION` in `src/infrastructure/persistence/schema-version.ts`, because the build compiles only `src/`; `migrations/index.ts` re-exports it, and the migrations spec checks that it names the last migration.
*   **Request context.** Every request gets a new `X-Request-Id`. An incoming `X-Correlation-Id` of 1–128 characters from `[A-Za-z0-9._:-]` is kept, and any other value is replaced by a new UUIDv7. Both are returned as response headers and carried into every log line of the request.
*   **Readiness and routing.** Readiness covers SQS, as challenge §9 requires. In the shipped topology nothing routes on readiness, so HTTP keeps serving during an SQS outage. A production setup behind a load balancer would split HTTP readiness from consumer readiness.

## 9. HTTP contract and failure codes

| Route | Result responses | Error responses |
|---|---|---|
| `POST /wallets` | 201 `{id, playerId, balance, version}` | 400; 409 `WALLET_ALREADY_EXISTS` with `details.walletId` |
| `GET /wallets/:walletId` | 200 | 404 |
| `GET /wallets/:walletId/ledger?cursor&limit` | 200 `{items, nextCursor}`, ascending by wallet version; `limit` 1–200 (default 50); `nextCursor` is `null` on the last page | 400 `INVALID_CURSOR` or `VALIDATION_FAILED`, 404 |
| `POST /wagering/transactions` (`Idempotency-Key` required) | 200, 202 with `Location`, or 422, with the transaction result body | 400, 404, 409, 503, 500 |
| `GET /wagering/transactions/:transactionId` | 200 | 404 |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | 200 | 404 |
| `POST /wallets/:walletId/reconciliation` | 200, even when inconsistent | 404 |
| `GET /health/live`, `GET /health/ready`, `GET /metrics` | 200 | ready: 503 |

*   **Transaction result body:** `{ transactionId, status, balance, failureCode?, details?, idempotentReplay }`. `balance` is the wallet's balance when the result was decided, in the wallet's currency, and is `null` for `PENDING_REFERENCE` and `FAILED`. Only a `CURRENCY_MISMATCH` rejection has a `balance` in another currency than its `money`.
*   **`Idempotency-Key`** is validated like the body: a missing or malformed key is `400 VALIDATION_FAILED` with the issue path `idempotency-key`.
*   **`422` always means a persisted, final transaction result.**
*   **Every other error** uses `{ "error": { "code", "message", "details?" } }`.
*   **Every `503` carries `Retry-After`.**

| Code | Persisted | HTTP | SQS | Provider action |
|---|---|---|---|---|
| `VALIDATION_FAILED` | no | 400 | DLQ | `RESEND_SAME_KEY` after fixing the payload |
| `IDEMPOTENCY_KEY_CONFLICT` | no | 409 | DLQ | `STOP` |
| `EXTERNAL_TRANSACTION_ID_CONFLICT` | no | 409 | DLQ | `STOP` (read the original with its key) |
| `MESSAGE_ID_CONFLICT` | no | — | DLQ | `STOP` (producer bug) |
| `WALLET_NOT_FOUND` | no | 404 | DLQ | `RESEND_SAME_KEY` after fixing the `walletId` |
| `WALLET_ALREADY_EXISTS` | no | 409 | — | `STOP` (use the existing wallet) |
| `TRANSACTION_NOT_FOUND` / `INVALID_CURSOR` | — | 404 / 400 | — | `STOP` |
| `SERVICE_UNAVAILABLE` | no, or unknown if the commit was cut | 503 | visibility backoff | `RESEND_SAME_KEY` |
| `INTERNAL_ERROR` | unknown | 500 | backoff; DLQ on the 3rd receive | `RESEND_SAME_KEY` |
| `INSUFFICIENT_FUNDS` | yes | 422 | ack | `RESEND_NEW_EXTERNAL_ID` |
| `REVERSAL_INSUFFICIENT_FUNDS`, `BALANCE_LIMIT_EXCEEDED` | yes | 422 | ack | `STOP` (operator follow-up) |
| `CURRENCY_MISMATCH`, `WALLET_PLAYER_MISMATCH`, `REFERENCE_INVALID`, `REFERENCE_MISMATCH` | yes | 422 | ack | `RESEND_NEW_EXTERNAL_ID` |
| `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED` | yes | 422 | ack | `STOP` |
| `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_READY` | yes | 422 | ack | `RESEND_NEW_EXTERNAL_ID` (send the reference first) |
| `PROCESSING_FAILED` | yes (`FAILED`) | 422 | — | `STOP` (operator follow-up) |

DLQ-only reasons: `UNEXPECTED_ERROR` (3rd receive) and `RETRY_BUDGET_EXHAUSTED` (10th receive).

## 10. Interpretations of the challenge

| Challenge text | Reading | Why |
|---|---|---|
| "A referência não pode ser revertida duas vezes pelo mesmo tipo" | One successful direct reversal per transaction, across `REFUND` and `ROLLBACK` | Allowing one of each would return a refunded stake twice. |
| `WIN` "pode referenciar a BET" | The reference is optional; when present it must be valid | The wording is permissive. |
| `LOSS` records the result without moving the balance | Any non-negative informational amount; an optional `BET` reference under the `WIN` rules | A provider that sends the stake is not rejected. |
| `WIN` or `LOSS` against a reversed `BET` | Processed in either order. When the reversal was processed first, the `WIN` or `LOSS` is flagged with `details.referenceReversedBy` in the response, the replay, and `WagerTransactionProcessed`; when it came first, it stays unflagged and the reversal is processed normally | The challenge has no round state; rejecting would make the outcome depend on arrival order. A decided result is never rewritten, so the flag describes what was known at decision time. |
| `FAILED` = "erro permanente de infraestrutura" | An unexpected error that persists until the reference TTL; used only for pending rows | Transient infrastructure errors never cause `FAILED`; a final result is final per external ID. |
| A repeat returns "o resultado original" | Terminal results replay their snapshot; a pending operation replays its eventual terminal result | A pending answer is not final. |
| Idempotency key as "fonte da verdade" | Scoped per provider and never part of the hash; the external ID is unique on its own | The challenge's default key format includes the provider; one operation must not move money twice. |
| `amount` with two decimals | Strict grammar and a ceiling of `999,999,999,999.99` | An explicit, testable limit. |
| Unknown wallet | `404`, not persisted, on every endpoint | Keeps the foreign key and keeps `422` meaning one thing. |
| `OPENING` is internal | Its own factory, with null provider fields | The challenge's `create()` requires provider fields. |
| Reconciliation response | The required fields plus an additive `issues` array | Diagnosis without changing the contract. |
| SQS message | `data.idempotencyKey` plays the role of the HTTP header | As in challenge §10. |

## 11. Risks, limitations, and non-goals

### Risks and limitations

| Risk | Impact | Mitigation or accepted limit |
|---|---|---|
| Authentication is not implemented | A caller can debit any wallet whose ID it knows, or take another provider's external ID first | Accepted for the challenge; the Keycloak design binds `providerId` to the token; startup warning. |
| Reconciliation and `/metrics` are open | Repeated reconciliations load the database | The reconciliation bulkhead (2 connections per instance). |
| Anyone can create pending reversals for references that never arrive | Each costs about 290 attempts over 24 h | One worker connection per instance; busy wallets are skipped; `pending_references` exposes growth. |
| One wallet's writes are serialized | A burst gets `503` after `lock_timeout` and can fill one instance's HTTP share | Accepted: serialization is the correctness mechanism; other roles keep their connections. |
| Instance count | 20 connections per instance and `max_connections = 200` allow about 9 instances | A connection pooler is the next step. |
| The provider chooses the FIFO group | A coarse group serializes many wallets; a message under contention blocks its group for about 5 minutes | `walletId` is the recommended group. |
| Messages behind a failing message share its receives | A valid message can reach the DLQ as `RETRY_BUDGET_EXHAUSTED` | Released only on a backoff; that reason is safe to redrive. |
| Unknown commit outcome when the connection drops during `COMMIT` | The provider cannot tell whether the operation applied | `503`; resending with the same key is safe. |
| Writes that bypass the triggers | Ledger and balance can diverge | Reconciliation reports it and never corrects. |
| Events retried forever | A poison event is retried every 5 minutes | Lag and fault metrics; it blocks no other event. |
| Tables grow without bound | Storage and reconciliation time grow | Retention is a non-goal. |
| Platform behavior on Bun (MikroORM 7, MiniStack, `@nestjs/resilience` 0.0.3) | Guarantees that depend on it fail | A platform spike test with a fallback per item (TypeORM; an earlier MiniStack tag; the same behaviors written in the project). |

### Non-goals

*   Partial reversals: a reversal must match the referenced amount.
*   Round state: whether a round is open, settled, or cancelled belongs to the provider.
*   Per-currency rules: every currency has two decimals and the same ceiling.
*   Event ordering beyond what FIFO groups give per wallet; `walletVersion` lets consumers order balance events.
*   Retention of inbox and outbox rows.
*   Implemented authentication (designed in §6).
*   Future extensions, documented but not built: SNS fan-out, a provider registry, ledger balance checkpoints, OpenTelemetry tracing, dashboards.
*   Load testing until every mandatory requirement is done; if built, it runs as `bun run test:load`.

## Appendix A: decision log

In chronological order. A revised decision is not deleted: it is marked **Superseded** and points to its replacement. The current rule is always in the main body.

| # | Decision | Status |
|---|---|---|
| 1 | Initial business rules: reversals, reference states, an optional `WIN` reference, amounts, identity, and replay. | Decided; refined by 19–23 |
| 2 | MikroORM, a per-wallet pessimistic lock, and Bun as the runtime and test runner. | Decided |
| 3 | Unconstrained `NUMERIC` with no business maximum. | **Superseded** by 4 |
| 4 | A ceiling of `999,999,999,999.99`, BigInt minor units, and `NUMERIC(14,2)`. | Decided (§2) |
| 5 | MiniStack instead of LocalStack, so evaluators need no account or token. | Decided |
| 6 | Idempotency, outbox, and worker coordination built in the project, not with `@nestjs/idempotency`, `@nestjs/outbox`, or `@nestjs/locks`, because those keep their state outside the business transaction or lack MikroORM and SQS support. | Decided |
| 7 | HTTP status map and failure codes, with `422` for an unknown wallet and a replay status fixed at first response. | **Superseded** in part: the unknown wallet by 23, the replay status by 18 |
| 8 | Two canonical hashes: a business hash and a separate inbox message hash. | **Superseded** by 25 |
| 9 | Schema constraints, the deferred commit-time trigger, and the lock-order invariant. | Decided; extended by 18 and 29 |
| 10 | Outbox to a FIFO queue with a per-claim lease token, and no dead-letter state. | Lease **Superseded** by 25; no dead-letter kept |
| 11 | SQS error classification, the polling pause, and graceful shutdown; native redrive for transient failures. | DLQ routing **Superseded** by 24 |
| 12 | A lease-free pending-reference worker, the wake-up of dependents, and `FAILED` after three consecutive errors. | `FAILED` rule **Superseded** by 20 |
| 13 | Keycloak designed and documented, not implemented. | Decided |
| 14 | No static allowlist of known providers as a stand-in for authentication. | Decided |
| 15 | Reconciliation in a read-only snapshot with SQL aggregates; the `Money` / input contract / `Wallet` layering of limits. | Decided |
| 16 | MikroORM persistence records separate from the domain classes; one transactional entity manager per operation. | Decided |
| 17 | One image with role flags, a one-shot setup service, three app instances, Prometheus metrics, JSON logs, and the three test layers. | Decided; connection shares **Superseded** by 29 |
| 18 | Design-review fixes: per-entry outbox confirmation, inbox lookup before the fast replay path, replay status taken from the stored state, error classes, and test isolation. | Decided |
| 19 | A terminal result is final for its external ID. | Decided |
| 20 | `FAILED` only when the final attempt at the reference TTL throws; replayed as `422 PROCESSING_FAILED`. | Decided |
| 21 | `LOSS` takes any non-negative informational amount and an optional `BET` reference. | Decided; supersedes the `LOSS` part of 1 |
| 22 | A `WIN` or `LOSS` against a reversed `BET` is processed and flagged with `referenceReversedBy`. | Decided; refined by 30 |
| 23 | `404 WALLET_NOT_FOUND` on every endpoint; `422` reserved for a persisted transaction result. | Decided |
| 24 | One application DLQ path with budgets of 3 (unexpected) and 10 (contention, outage) and a 60 s backoff cap; native redrive at 15 as a backstop. | Redrive threshold **Superseded** by 29 |
| 25 | Simplifications: outbox without a lease (one transaction with `SKIP LOCKED`), one payload hash for idempotency and the inbox, one authentication port, Zod schemas shared by HTTP and SQS, one polling loop. | Decided |
| 26 | Layer folders enforced by lint, MikroORM 7, Zod 4, the `NodeAdapter`, sequential migration names, configuration parsed with Zod. | `NodeAdapter` **Superseded** by 29 |
| 27 | `wagering_app` gets only `SELECT`, `INSERT`, and `UPDATE`; grants and triggers are independent barriers. | Decided |
| 28 | The `nest start` script is removed; development runs the source on Bun, and production runs the `tsc` build on Bun. | Decided |
| 29 | Design review outcome, listed below this table. | Decided |
| 30 | Domain implementation (task 03): `referenceReversedBy` flags only a `WIN` or `LOSS` decided after its `BET` was reversed, because terminal results are never rewritten; `REFERENCE_ALREADY_REVERSED` also carries `details.referenceReversedBy`. This refines the "both arrival orders" wording of the task 03 and task 08 test lists in the design document. | Decided |
| 31 | Persistence implementation (task 04), listed below this table. | Decided |
| 32 | Wallets, reconciliation, and the operational base (task 05), listed below this table. | Decided |
| 33 | Basic processing and persistent idempotency (task 06), listed below this table. | Decided |
| 34 | HTTP concurrency verification (task 07), listed below this table. | Decided |
| 35 | Reversals and the pending-reference worker (task 08), listed below this table. | Decided |
| 36 | SQS consumption with the inbox, retries, and the DLQ (task 09), listed below this table. | Decided |

Decision 29 settled these points:

*   **Ledger.** A ledger-chain check in the commit trigger; the direction checks are kept.
*   **SQS consumer.**
    *   Serial processing within a FIFO group, with the rest of the group released only on backoff.
    *   Native redrive at 50.
    *   A deferred inbox foreign key, with the transaction ID generated before the transaction.
*   **Resilience.**
    *   `@nestjs/resilience` for the retry, the bulkheads, and the circuits; circuits count only outages.
    *   `@nestjs/schedule` rejected (no pause, backoff, or drain).
*   **Platform.**
    *   A pool of 20 connections with fixed shares.
    *   Express kept, because there is no throughput target.
    *   `src/contracts` for the inbound schemas.
*   **Tests.** A separate test database, a TCP proxy for outages, and per-spec queues.
*   **Scope.** A Core and Stretch split.

Decision 31 settled these points:

*   **Trigger errors.** Triggers raise SQLSTATE `23000` with the trigger name as the constraint. `TRUNCATE` is refused by trigger on every table except `inbox`, not only on the ledger.
*   **Checks and triggers.** Row triggers run before `CHECK` constraints, so the status checks are a second barrier, tested with triggers bypassed.
*   **Flush.** The ORM flushes only at commit; records declare relations mapped to the plain ID so inserts follow the foreign keys.
*   **Pending times.** The repository reads the next attempt and the expiry from the database clock, rounded to milliseconds like the columns, before the insert, because the insert itself happens at the flush.
*   **Wallet conflict.** The error classifier raises `WalletAlreadyExists` without the ID; the use case re-reads and fills it in.
*   **Processed without an entry.** A fifth deferred check on `wager_transactions` refuses a `PROCESSED` transaction of a balance-moving kind without its ledger entry. Without it, a manual insert could record an operation as applied without moving the balance, and reconciliation would not see it, because the balance still equals the ledger.
*   **Indexes.** The ledger `(wallet_id, wallet_version)` lookup uses the unique constraint's index; no duplicate index is created.

Decision 32 settled these points:

*   **Opening a wallet.** `applyOutcome` records an `OPENING` without `Wallet.apply`: the new wallet already holds the opening balance at version 1, so the entry records the move from zero at version 1. A worker attempt that still waits is a reschedule, not an `applyOutcome` call.
*   **Wallet conflicts.** `OpenWallet` checks for an existing wallet first; a concurrent open that wins at commit is re-read in a second unit of work, so every `409` carries `details.walletId`.
*   **Logger port.** `AppLogger` lets use cases log warnings (a reconciliation divergence, and later the worker's) without importing Nest. Its adapter writes through the JSON logger, so the request-context fields are merged in.
*   **One pool per process.** `MikroOrmModule.forRoot` is not used: it would open a second pool beside the container's. Nest modules expose the container's adapters instead.
*   **Schema version.** `LATEST_MIGRATION` moved into `src/` (see §8, Health).
*   **Error contract details.** A malformed path parameter or body is `400 VALIDATION_FAILED`, with each issue named by its field or parameter. Malformed JSON is also `400 VALIDATION_FAILED`. An unknown route is `404 NOT_FOUND` in the error envelope. Readiness keeps the health-check body, which names each check.
*   **Ledger pages.** A page reads one entry beyond `limit`; `nextCursor` is set only when that entry exists, so the last page always has `nextCursor: null`, even when it is full. An unknown wallet is `404` before any cursor is used.
*   **Test fakes.** The recording publisher arrives with the `EventPublisher` port in task 10; task 05 adds the other fakes and a recording logger.

Decision 33 settled these points:

*   **Snapshot currency.** The result snapshot is the wallet's balance. The first schema required its currency to equal the operation's for every decided row, which made a `CURRENCY_MISMATCH` rejection impossible to store. Migration `0007` keeps that equality for `PROCESSED`, where D3 has passed, and requires only a present currency for `REJECTED`.
*   **Header validation.** Nest's `@Headers` takes neither a schema nor pipes. A small `@RequestHeader(name, { schema })` decorator reads one header, and the global validation pipe validates custom decorators that declare a schema, so the key fails exactly like a body field.
*   **Reference on the result.** `applyOutcome` records the resolved reference's ID on a processed result. The commit-time direction check of a `ROLLBACK` and the one-successful-reversal index both read it.
*   **Found under the lock.** When the re-read under the wallet lock finds the operation stored, the use case raises an internal signal so the unit of work rolls back (the SQS inbox row was already inserted), then answers the replay; an SQS replay records its inbox row in the short replay transaction.
*   **Duplicate deliveries.** `SubmitResult` carries `duplicate` next to `replay`, so the SQS consumer (task 09) can count an inbox duplicate without reading the inbox again. A duplicate is not counted as an idempotent replay.
*   **Hashed fields.** `payloadHash` picks the operation's fields explicitly, so the SQS `data`, which also carries `idempotencyKey`, hashes the same as the HTTP body.

Decision 34 settled these points:

*   **Identity race in the unlocked lookup.** The duplicate-bet scenario (50 copies over 3 processes) showed copies answered with `409 EXTERNAL_TRANSACTION_ID_CONFLICT`: the key read missed the winner, which committed before the external-ID read found it. The decision table now applies to the row found, judged by its key, so that copy is a replay. A unit test places the commit between the two reads.
*   **Shedding in the hot-wallet test.** The test shrinks the HTTP bulkhead to 4 running and 4 queued per process, so a 200-request burst overflows it on every run. The burst is sent once without resending `503`s; the quiet wallets' requests resend `503` with the same key and must all be processed.
*   **Shared cluster helper.** `test/support/cluster.ts` starts the processes of a concurrency spec, asserts distinct PIDs, and stops them after the spec.

Decision 35 settled these points:

*   **Two units of work per attempt.** The worker first reads the row without a lock, to learn its wallet and whether its TTL is reached (which picks `SKIP LOCKED` or a blocking lock). The attempt itself runs in a new unit of work: the ORM's identity map would return a row loaded before the lock unchanged, so the row is re-checked and loaded only after the wallet lock, on a fresh fork.
*   **Recovery reads the row again.** After an unexpected error, a new unit of work re-checks the row with the database clock: not due any more, it is left alone; before the TTL, it is rescheduled with the attempt counted; at the TTL, a third unit of work locks the wallet, confirms the row is still pending, and writes `FAILED`. A failed recovery leaves the row due for the next cycle.
*   **Attempt metrics.** `reference_attempts_total{outcome}` counts a busy wallet, a window another worker already handled, and contention as `skipped`, and an unexpected error that was rescheduled as `wait`. Worker decisions also count in `wager_transactions_total` with `channel="worker"`.
*   **Shared reference resolution.** Submission and the worker read the reference, its ledger entry for a `ROLLBACK`, and its successful reversal through one function, so both feed `settle()` the same input.
*   **Polling loop.** A failed cycle is logged and followed by the idle wait, like an empty one. The loop is built in the container and started by `WorkersModule` when `REFERENCE_WORKER_ENABLED`; it stops in `beforeApplicationShutdown`, so the cycle in progress finishes before the pool closes.
*   **Due-row count.** The first version aliased its subquery `window`, a reserved word in PostgreSQL, so every select failed. Nothing ran the worker's reads against the database until this task; an integration test now covers `selectDue` and `recheck`.
*   **Exact arrival order in tests.** The reversals spec runs a process without the worker and runs worker cycles in process, so a `WIN` that arrives before its `BET` is decided only after the `REFUND`, as decision 30 requires for the flag. The two-worker spec polls the row and asserts that each change of `attempts` is one step, taken after the previous window opened.

Decision 36 settled these points:

*   **Where the inbox lives.** The inbox lookup, the short replay transaction, and the inbox insert that inserts nothing were already in `SubmitWagerTransaction` (decision 33). `ProcessWagerMessage` only builds the command and classifies the result, and counts `inbox_duplicates_total` and `message_id_conflicts_total`.
*   **Envelope validation in the adapter.** The application layer imports no contracts, so the consumer validates the envelope and passes the operation and its key; an invalid envelope is a DLQ move, never an application call.
*   **Backoff in whole seconds.** `ChangeMessageVisibility` takes seconds, so the backoff is rounded up and is at least 1 s. It has no jitter.
*   **SQS circuit.** `policies.sqs` classifies an SQS error inside the circuit, so only an unreachable SQS, a 5xx, or throttling is recorded.
*   **Queue URLs on first use.** They are looked up by name when first needed and kept; a failed lookup is not kept, so an instance that boots while SQS is down finds its queues once SQS is back.
*   **Readiness.** The SQS check calls `GetQueueAttributes` outside the `sqs` circuit, so a readiness probe never closes it.
*   **Fault points.** `crash-after-commit` sends `SIGKILL` to the process between commit and delete, so no shutdown hook runs. `unexpected-on-wallet` wraps the submitter and fails before any read, so its wallet need not exist.
*   **Error logs.** The application logger gained `error`, used for an unexpected error while processing a message. The line carries the error name only, because a driver message can quote payload values.
*   **Tests.**
    *   A spec can set environment for its queues and processes, so the crash spec's queue has a 5 s visibility timeout.
    *   The ordering spec sends each group in one `SendMessageBatch`, so the whole group is visible before the next receive. A DLQ move without a release is shown by each later message reaching the DLQ on its first receive.
    *   The race where HTTP commits between the SQS lookup and the lock is placed by holding the wallet lock, queueing the HTTP request on it, then the SQS delivery, and releasing.
    *   With two concurrent deliveries of one `messageId` and different payloads, either may win; the spec checks that the other one is the DLQ message.
    *   `parallel-wallets` and `out-of-order` send half of their operations over SQS; in `out-of-order`, each bet goes over the other channel than its reversal. `hot-wallet` adds one SQS bet per quiet wallet.
