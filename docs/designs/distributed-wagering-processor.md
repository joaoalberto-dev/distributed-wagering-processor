# Distributed Wagering Processor

*   **Author:** João Alberto
*   **Status:** Reviewed (EGM review stages 5–9, 2026-11-12); frozen once `ARCHITECTURE.md` is written in task 01
*   **Date:** 2026-11-11 (last updated 2026-11-12)

--------------------------------------------------------------------------------

## Overview

Game providers report wagering operations from their games to the casino's wallet service:

*   a player bets (`BET`);
*   wins (`WIN`);
*   loses (`LOSS`);
*   has a bet refunded (`REFUND`);
*   has an earlier operation undone (`ROLLBACK`).

This service receives those operations over HTTP and from an SQS queue. It applies each one to the player's wallet, records every balance change in an append-only ledger, and publishes integration events about the outcome. Each operation is applied exactly once, even when it arrives several times, arrives before the operation it refers to, or is processed by several instances at the same moment.

The service is the delivery for the Jungle Gaming technical challenge ([`CHALLENGE.md`](../../CHALLENGE.md)). Evaluators run it locally with Docker and Bun, read `README.md` and `ARCHITECTURE.md`, and grade it on financial correctness, concurrency, idempotency, messaging and failure recovery, modeling, tests, observability, and documentation. The first four areas are worth 70 of the 100 points.

The repository starts as the NestJS starter, already moved to Bun tests, oxlint, and oxfmt. This design replaces the starter code. In this document, "§N" refers to this document's sections and "challenge §N" to the sections of `CHALLENGE.md`.

## The Problem

A wallet service sits between game providers and the player's money. Providers deliver at least once. In practice this means four things:

*   **Duplicates.** The same operation can arrive many times, through HTTP retries, SQS redelivery, or a provider resending after a timeout. If it is applied twice, the player is debited or credited twice.
*   **Out of order.** A `REFUND` or `ROLLBACK` can arrive before the `BET` it reverses. Rejecting it loses a legitimate reversal. Applying it without its reference corrupts the balance.
*   **Simultaneous.** Several instances can process operations for the same wallet at the same moment. Without control, two bets can each see enough balance and together drive the balance negative, or one update can overwrite another.
*   **Interrupted.** A process can die before or after committing, and PostgreSQL or SQS can be briefly unavailable. Work must neither be lost nor done twice, and an event about a committed outcome must never be lost.

An implementation can look complete and still have the following defects. The design and the tests target each one:

*   replays that change the currency of the reported balance;
*   inbox checks that skip the payload comparison;
*   workers that overwrite a processed reversal with a rejection;
*   outbox leases that reopen published events;
*   concurrency tests that never run concurrently;
*   integration tests that pass when the infrastructure is missing.

**Proposed solution.** PostgreSQL is the single source of truth and enforces the money invariants in its schema:

*   unique identities;
*   a non-negative balance;
*   an immutable ledger;
*   one successful reversal per transaction;
*   a commit-time check that each wallet's balance equals its ledger, and that each ledger entry continues the previous one.

Each operation runs in one SQL transaction that locks only its wallet's row, re-reads everything after taking the lock, and writes the transaction, balance change, ledger entry, inbox record, and outbox events together. HTTP and SQS share one use case and one decision function. Background workers retry pending references with backoff, publish committed events, and recover from crashes without coordination beyond row locks. Each goal maps to tests against real PostgreSQL and SQS. SQS runs on MiniStack, an SQS emulator that needs no account; its image is pinned in task 02. The concurrency and crash tests run three or more processes.

## Goals

The service is correct when all of the following hold. Each goal maps to tests in the [Verification Plan](#verification-plan).

*   **G1 — No money is created or lost.**
    *   After every test scenario, each touched wallet's stored balance equals the balance reconstructed from its ledger.
    *   No balance is ever negative.
    *   No operation produces more than one ledger entry.
    *   PostgreSQL rejects direct SQL writes that would break these rules.
*   **G2 — Correct under contention.**
    *   With a balance of `100.00 BRL`, two simultaneous `80.00 BRL` bets end with exactly one `PROCESSED`, one `REJECTED` (`INSUFFICIENT_FUNDS`), a balance of `20.00 BRL`, and one debit entry.
    *   This holds with three processes running and the two bets sent to two different ones.
*   **G3 — Exactly-once effect under duplicates.**
    *   The same bet sent 50 times in parallel across three processes produces one debit, and every response reports the same transaction and the same balance snapshot.
    *   A repeated request returns the original result with `idempotentReplay: true`.
    *   The same key with a different payload returns a conflict, not a replay.
*   **G4 — Out-of-order operations converge.**
    *   A `REFUND` or `ROLLBACK` that arrives before its reference is held as `PENDING_REFERENCE` and applied once the reference is processed.
    *   If the reference never arrives within 24 hours (configurable), it is rejected with `REFERENCE_NOT_FOUND`.
    *   In both cases an event is published.
*   **G5 — Crash and outage recovery.**
    *   A consumer killed after commit and before acknowledgment has its message redelivered to a surviving process. The survivor treats it as a duplicate, and the queue and DLQ end empty.
    *   A publisher killed mid-send has its events republished by another instance with the same `eventId`.
    *   After a full restart, every pending item completes and every wallet reconciles.
*   **G6 — No committed event is lost.**
    *   Every committed financial outcome produces its integration events through the transactional outbox.
    *   Events are retried until published, with no dead-letter state.
*   **G7 — Clear contracts for providers.**
    *   HTTP status codes distinguish invalid payloads (400), unknown wallets (404), identity conflicts (409), persisted final transaction results (422), pending acceptance (202), and transient failures (503).
    *   Every rejection carries a stable `failureCode`. The §6 table gives each code one action class: `RESEND_SAME_KEY`, `RESEND_NEW_EXTERNAL_ID`, or `STOP`.
*   **G8 — Operable.**
    *   Structured JSON logs carry correlation and entity IDs and never carry amounts or payloads.
    *   Prometheus metrics cover the seven categories the challenge requires.
    *   Liveness and readiness are separate, and readiness checks PostgreSQL, SQS, and the schema version.
    *   Reconciliation reports divergence without correcting it.
*   **G9 — Reproducible evaluation.**
    *   From a fresh clone, `docker compose up` followed by the documented Bun commands runs every test layer with no account or token.
    *   A missing dependency fails the tests instead of skipping them.

## Non-Goals

*   **Partial reversals.** A `REFUND` or `ROLLBACK` must match the referenced amount exactly, as the challenge specifies.
*   **Implementing authentication.** The challenge awards no points for it. The Keycloak design is documented, and the code exposes one extension point (`ProviderIdentityPort`). Until it is implemented, any well-formed `providerId` is accepted.
*   **Round state.** The service does not track whether a round is open, settled, or cancelled. That coherence belongs to the provider. A `WIN` or `LOSS` against a reversed `BET` is processed and flagged.
*   **Per-currency rules.** The model is multi-currency, but every currency uses two decimal places and the same ceiling of `999,999,999,999.99`.
*   **Event ordering.** Consumers receive no ordering promise beyond what FIFO groups give per wallet. `walletVersion` lets them order balance events themselves.
*   **Retention.** Old inbox and outbox rows are not cleaned up.
*   **Future extensions,** documented but not built:
    *   SNS fan-out;
    *   a provider registry;
    *   ledger balance checkpoints;
    *   OpenTelemetry tracing;
    *   dashboards.
*   **Load testing.** Deferred until every mandatory requirement is done. It is optional; if built, it runs as `bun run test:load`.

## Open Questions

None. The implementation-level questions (folder layout, MikroORM version, Zod version, migration naming) are settled under "Settled implementation choices" in the Detailed Implementation Plan.

## Critical User Journeys (CUJs)

### CUJ 1: A provider places a bet and retries it

*   **Given**:
    *   A wallet for player P exists with `100.00 BRL`.
    *   Provider A sends `BET 25.00` with key `A:t-1` over HTTP.
*   **When**: The request times out on the provider side, and the provider resends it twice, the second time through the SQS queue.
*   **Then**:
    *   The first request returns `200 PROCESSED` with balance `75.00`.
    *   The HTTP retry returns `200` with the same transaction ID and balance and `idempotentReplay: true`.
    *   The SQS retry is acknowledged as a replay: `idempotent_replays_total` increases, and no second effect or event is produced.
    *   The wallet holds one debit entry, and reconciliation reports `consistent: true`.

### CUJ 2: Two bets compete for the same balance

*   **Given**: A wallet with `100.00 BRL`.
*   **When**: Two different `80.00` bets arrive at the same moment on two different instances.
*   **Then**:
    *   One returns `200 PROCESSED`.
    *   The other returns `422 REJECTED` with `INSUFFICIENT_FUNDS`.
    *   The balance is `20.00`, with one debit entry.

### CUJ 3: A refund arrives before its bet

*   **Given**: A wallet with `100.00 BRL`.
*   **When**:
    *   A `REFUND 25.00` referencing bet `t-1` arrives before `t-1`.
    *   `t-1` arrives a few seconds later.
*   **Then**:
    *   The refund returns `202` with status `PENDING_REFERENCE`, and a `WagerTransactionPendingReference` event is published.
    *   When the bet is processed, the refund is rescheduled and applied on the worker's next cycle, at most about 1 s later when the worker is idle (see the tuning table in the Detailed Implementation Plan).
    *   The final balance is `100.00`, with one debit and one credit.
    *   A replay of the refund now returns `200 PROCESSED`.

### CUJ 4: A consumer dies after committing

*   **Given**: Three processes consume `wager-transactions.fifo`.
*   **When**: The process handling a `BET` message commits and is killed before it deletes the message.
*   **Then**:
    *   After the visibility timeout, a surviving process receives the message, finds the inbox record with the same payload, and acknowledges it without a second effect.
    *   The queue and the DLQ are empty, and the wallet has one debit.

### CUJ 5: An operator checks a wallet

*   **Given**: A wallet that has processed many operations.
*   **When**: An operator calls `POST /wallets/:walletId/reconciliation`, reads `GET /wallets/:walletId/ledger` page by page, and scrapes `/metrics`.
*   **Then**:
    *   Reconciliation returns the stored and calculated balances, a signed difference, `checkedEntries`, and an empty `issues` list.
    *   The ledger pages are stable and ordered by wallet version.
    *   The metrics show transactions by status, duplicates, retries, DLQ moves, lock waits, outbox lag, and latency.

### CUJ 6: SQS is down for ten minutes

*   **Given**: SQS is unreachable for ten minutes while bets keep arriving over HTTP.
*   **When**: SQS comes back.
*   **Then**:
    *   During the outage, HTTP operations kept committing, the outbox backlog grew, and `outbox_lag_seconds` rose.
    *   After recovery, every pending event is published with its original `eventId`, and none is dropped.

## Technical Plan (Architecture)

### 1. System context

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

All instances run the same image, and every instance runs every role by default. Instances share no memory: they coordinate only through PostgreSQL row locks, unique constraints, and `SKIP LOCKED`. The SQS queues are delivery channels. They do not guarantee consistency.

### 2. Logical components

| Layer | Contents | Depends on |
|---|---|---|
| Domain | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, integration events, `settle()`, failure codes | nothing (no NestJS, no ORM) |
| Application | `SubmitWagerTransaction` (shared by HTTP and SQS), `ProcessWagerMessage` (SQS inbox handling), `OpenWallet`, queries, `ReconcileWallet`, `ResolvePendingReferences`, `PublishOutbox`; the ports listed below | Domain |
| Infrastructure | MikroORM records, mappers, and repositories; the SQS consumer (an inbound adapter that calls the application) and the `EventPublisher` adapter; the polling loop and resilience policies; logging, request context, metrics, health | Domain, Application, Contracts |
| Interface | NestJS HTTP controllers, request-context middleware, error mapping | Domain, Application, Contracts |
| Contracts | Zod schemas for inbound payloads: the HTTP body and the SQS envelope | nothing but `zod` |

**Ports** (all of them, defined in the application layer):

*   `UnitOfWork`;
*   `WalletRepository`, `TransactionRepository`, `LedgerRepository`, `InboxRepository`, `OutboxRepository`, `ReconciliationReader`;
*   `EventPublisher`, `ProviderIdentityPort`;
*   `Clock`, `IdGenerator`, `Telemetry`, `RequestContext`.

**Migrations** live in the top-level `migrations/` folder, outside `src/`, because the one-shot setup runs them from source.

**Schemas.** One core operation schema is the HTTP body. The SQS `data` schema extends it with `idempotencyKey` (see §8), so both channels validate the same business fields.

The folder layout follows these layers; see [Dependency rule](#dependency-rule) in the Detailed Implementation Plan.

### 3. Money

Rejected alternatives: A1–A3.

*   **Representation.**
    *   `Money` holds an amount in BigInt minor units (cents) and an ISO-4217 currency. It is immutable, and arithmetic between different currencies throws a domain error.
    *   JavaScript `number` is never used for money. BigInt never leaves the domain: responses, events, and persistence carry the decimal string (`MoneyProps`). Logs never carry amounts (§18).
*   **`Money.from({ amount, currency })` parses strictly.**
    *   The amount must match `^-?(0|[1-9][0-9]{0,17})\.[0-9]{2}$`, and string length is checked before conversion.
    *   The currency must match `^[A-Z]{3}$`.
    *   It rejects NaN, Infinity, exponent notation, the empty string, missing or extra decimals, leading zeros, a leading `+`, `-0.00`, and whitespace.
    *   `Money.ofMinor(bigint, currency)` serves arithmetic and reconciliation.
*   **Rule layering.**
    *   `Money` itself may be negative or above the ceiling, because `negate()` and reconciliation of corrupted data need that.
    *   The input-contract parser adds the non-negative rule and the ceiling of `999,999,999,999.99`, using `^(0|[1-9][0-9]{0,11})\.[0-9]{2}$`.
    *   `Wallet` keeps every balance between 0 and the ceiling.
*   **Storage.**
    *   Every monetary column is `NUMERIC(14,2)`. Its capacity equals the ceiling, so PostgreSQL rejects any larger value.
    *   The column limits magnitude but not scale: a direct SQL write of `1.005` is rounded. The domain is the guard for scale.

### 4. Domain model and transaction lifecycle

*   **Factories.**
    *   Every aggregate has a private constructor, a creation factory, and `rehydrate`.
    *   The creation factories are `Wallet.open`, `WagerTransaction.create` (provider operations), `WagerTransaction.open` (the internal `OPENING`, which has no provider fields), `WalletLedgerEntry.create` (which checks `balanceBefore ± amount = balanceAfter`), `InboxMessage.receive`, and `OutboxMessage.enqueue`.
    *   `rehydrate` rebuilds persisted state and does not re-validate transitions.
*   **One decision function.** Submission and the worker both call it, under the wallet lock:

    ```text
    settle(transaction, wallet, resolvedReference?, existingReversal?, now)
      → Processed { ledgerEntry? , details? }
      | Rejected  { failureCode, details? }
      | Wait
    ```

    A single persistence step writes its result: the transaction, the wallet, the ledger entry, the outbox events, and the wake-up of dependents (see §11, Wake-up). The same step also writes `FAILED` (§11, Errors).
*   **Time.** `now` comes from the application `Clock` and is used only for domain timestamps. Scheduling and the TTL (`next_reference_attempt_at`, `reference_expires_at`, outbox `next_attempt_at`) use the database clock only, so instances with skewed clocks agree on what is due.
*   **PENDING** exists only in memory, and the schema forbids storing it.
*   **Persisted lifecycle.** A database trigger allows only these persisted edges:
    *   insert as `PROCESSED`, `REJECTED`, or `PENDING_REFERENCE`;
    *   `PENDING_REFERENCE` to itself, `PROCESSED`, `REJECTED`, or `FAILED`.

    Any change to a terminal row is refused.
*   **Wallet.**
    *   `version` starts at 1 and increases only when the balance changes.
    *   A positive opening balance creates an `OPENING` transaction and its `CREDIT` entry in the same SQL transaction. A zero opening creates neither.

Lifecycle, including the in-memory `PENDING` state:

```mermaid
stateDiagram-v2
    [*] --> PENDING : create / open (in memory only)
    PENDING --> PROCESSED : settle → Processed
    PENDING --> REJECTED : settle → Rejected
    PENDING --> PENDING_REFERENCE : settle → Wait
    PENDING_REFERENCE --> PENDING_REFERENCE : worker reschedule (attempts, next attempt)
    PENDING_REFERENCE --> PROCESSED : worker settle → Processed
    PENDING_REFERENCE --> REJECTED : worker settle → Rejected, or TTL expiry
    PENDING_REFERENCE --> FAILED : final attempt at TTL throws unexpected error
    PROCESSED --> [*]
    REJECTED --> [*]
    FAILED --> [*]
```

### 5. Business rules and order of checks

Rejected alternatives: A12–A17.

The first failing check decides the outcome. HTTP and SQS run the full list (V, identity, D). The worker re-runs only the domain checks (D1–D11).

#### Input contract (V1–V7)

A failure gives `400 VALIDATION_FAILED`. It is not persisted, and an SQS message goes to the DLQ.

*   **V1.** Strict schemas: unknown fields are rejected in the HTTP body, the SQS envelope, and `data`.
*   **V2.** ID formats (see §8).
*   **V3.** Amount grammar, sign, and ceiling.
*   **V4.** `kind` is not `OPENING`.
*   **V5.** Reference presence by kind: required for `REFUND` and `ROLLBACK`; optional for `WIN` and `LOSS`; forbidden for `BET`.
*   **V6.** Amount by kind: positive for `BET`, `WIN`, `REFUND`, and `ROLLBACK`. Any non-negative amount for `LOSS`; it is informational and never moves the balance.
*   **V7.** No self-reference.

#### Identity

A conflict gives `409` and is not persisted. The rules are in the decision table in §8.

#### Domain checks, under the wallet lock (D1–D11)

A failure is a `422` result: persisted, and final for that external ID. There are two exceptions:

*   D1 gives `404` and is not persisted.
*   D4 and D8 can end in a wait: `202 PENDING_REFERENCE`.

The checks:

*   **D1.** The wallet exists. If not, the result is `404 WALLET_NOT_FOUND`, which is **not persisted**.
*   **D2.** The wallet belongs to the player, else `WALLET_PLAYER_MISMATCH`.
*   **D3.** The currency equals the wallet currency, else `CURRENCY_MISMATCH`.
*   **D4.** The reference is resolved by `(providerId, referenceExternalTransactionId)`:
    *   absent: wait as `PENDING_REFERENCE`;
    *   present in any status: D5–D8 apply.
*   **D5.** The reference has the same player, wallet, currency, and round, else `REFERENCE_MISMATCH`. The fields are compared in this order, and `details.field` names the first that differs: `playerId`, `walletId`, `currency`, `roundId`.
*   **D6.** The reference kind is allowed, else `REFERENCE_INVALID`:

    | Kind | May reference |
    |---|---|
    | `WIN`, `LOSS` | `BET` |
    | `REFUND` | `BET` |
    | `ROLLBACK` | `BET`, `WIN`, `REFUND` |

*   **D7.** For `REFUND` and `ROLLBACK`, the amount equals the reference amount, else `REFERENCE_MISMATCH` with `details.field = "amount"`.
*   **D8.** The reference status:
    *   `PENDING_REFERENCE`: wait;
    *   `REJECTED` or `FAILED`: `REFERENCE_NOT_PROCESSED`;
    *   `PROCESSED`: continue.
*   **D9.** Reversal allowance: at most one successful direct reversal per transaction, across `REFUND` and `ROLLBACK`, else `REFERENCE_ALREADY_REVERSED`.
    *   A `WIN` or `LOSS` against a reversed `BET` **is processed**. Its result carries `details.referenceReversedBy` (the reversal's `transactionId`), and a warning is logged. The counter `settlement_on_reversed_reference_total` is Stretch (task 14). The outcome does not depend on arrival order.
*   **D10.** Funds: a `BET` without funds gives `INSUFFICIENT_FUNDS`. A `ROLLBACK` debit without funds gives `REVERSAL_INSUFFICIENT_FUNDS`.
*   **D11.** Ceiling: a credit above the ceiling gives `BALANCE_LIMIT_EXCEEDED`.

#### Effects

| Kind | Effect |
|---|---|
| `BET` | debit |
| `WIN`, `REFUND`, `OPENING` | credit |
| `ROLLBACK` | the inverse of its reference's entry |
| `LOSS` | nothing: no ledger entry, no balance or version change, no `WalletBalanceChanged` event |

A round may have several `WIN`s, and a processed `REFUND` may itself be rolled back.

#### At or after the TTL

The worker runs D1–D11 once more:

*   a reference that is still absent gives `REFERENCE_NOT_FOUND`;
*   a reference that is still pending gives `REFERENCE_NOT_READY`.

### 6. Failure codes

A terminal result is final for its `externalTransactionId`. To try again, the provider sends a new external ID.

The action class tells the provider what to do without reading the message:

*   `RESEND_SAME_KEY`: the outcome is unknown or transient; resending with the same key is safe.
*   `RESEND_NEW_EXTERNAL_ID`: this external ID is final; a corrected or new operation needs a new external ID and key.
*   `STOP`: do not resend; read the original result or involve an operator.

| Code | Persisted | HTTP | SQS | Action class | Detail |
|---|---|---|---|---|---|
| `VALIDATION_FAILED` | no | 400 | DLQ | `RESEND_SAME_KEY` | Fix the payload; the key may be reused, because nothing was stored. |
| `IDEMPOTENCY_KEY_CONFLICT` | no | 409 | DLQ | `STOP` | Never send another payload with this key. |
| `EXTERNAL_TRANSACTION_ID_CONFLICT` | no | 409 | DLQ | `STOP` | Read the original result with the original key. |
| `MESSAGE_ID_CONFLICT` | no | — | DLQ | `STOP` | Producer bug: the envelope `messageId` was reused. |
| `WALLET_NOT_FOUND` | no | 404 | DLQ | `RESEND_SAME_KEY` | Fix the `walletId`; nothing was stored. |
| `WALLET_ALREADY_EXISTS` | no | 409, with `details.walletId` | — | `STOP` | Use the existing wallet. |
| `TRANSACTION_NOT_FOUND` | — | 404 | — | `STOP` | — |
| `INVALID_CURSOR` | — | 400 | — | `STOP` | Restart paging without a cursor. |
| `SERVICE_UNAVAILABLE` | no, or unknown if the commit was cut | 503 + `Retry-After` | visibility backoff | `RESEND_SAME_KEY` | Safe to resend. |
| `INTERNAL_ERROR` | unknown | 500 | backoff; DLQ on the 3rd receive | `RESEND_SAME_KEY` | Safe to resend. |
| `INSUFFICIENT_FUNDS` | yes | 422 | ack | `RESEND_NEW_EXTERNAL_ID` | A new bet needs a new external ID. |
| `REVERSAL_INSUFFICIENT_FUNDS`, `BALANCE_LIMIT_EXCEEDED` | yes | 422 | ack | `STOP` | Operator follow-up. |
| `CURRENCY_MISMATCH`, `WALLET_PLAYER_MISMATCH`, `REFERENCE_INVALID`, `REFERENCE_MISMATCH` | yes | 422 | ack | `RESEND_NEW_EXTERNAL_ID` | Resend corrected. |
| `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED` | yes | 422 | ack | `STOP` | Give up. |
| `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_READY` | yes | 422 | ack | `RESEND_NEW_EXTERNAL_ID` | Send the reference first, then the reversal. |
| `PROCESSING_FAILED` | yes (`FAILED`) | 422 | — | `STOP` | Operator follow-up. |

*   `result_details` is persisted. A replay returns the same `transactionId`, `status`, `balance`, `failureCode`, and `details` as the original response; only `idempotentReplay` differs.
*   The DLQ `failureReason` attribute uses the codes above plus two DLQ-only reasons:

    | DLQ reason | Meaning |
    |---|---|
    | `UNEXPECTED_ERROR` | an unclassified error on the 3rd receive |
    | `RETRY_BUDGET_EXHAUSTED` | contention or outage on the 10th receive |

### 7. HTTP API

*   **Replay status.**
    *   The status comes from the transaction's stored state when the response is served: `PROCESSED` → 200, `PENDING_REFERENCE` → 202 with `Location: /wagering/transactions/{id}`, `REJECTED` and `FAILED` → 422.
    *   For a row that was terminal when first answered, this equals the original status.
    *   A row that started as `PENDING_REFERENCE` replays its terminal result once the worker has decided it. That is how this design reads "the original result" (challenge §9) for an operation whose first answer was not final.
    *   A replay of a pending row is read-only: it takes no lock and never tries to resolve the reference.
*   **`422` always means a persisted, final transaction result.** Its body is the transaction result body:

    ```text
    {
      transactionId: string                    // UUIDv7
      status: "PROCESSED" | "REJECTED" | "PENDING_REFERENCE" | "FAILED"
      balance: MoneyProps | null               // snapshot when decided; null for PENDING_REFERENCE and FAILED
      failureCode?: string                     // §6
      details?: object                         // e.g. { field }, { referenceReversedBy }
      idempotentReplay: boolean
    }
    ```

*   **Every other error** uses `{ "error": { "code", "message", "details?" } }`.

#### Request body of `POST /wagering/transactions`

The body has the field names of challenge §9; `MoneyProps` is `{ amount: "25.00", currency: "BRL" }`.

| Field | Required | Format |
|---|---|---|
| `providerId` | yes | 1–128 of `[A-Za-z0-9._:-]` |
| `externalTransactionId` | yes | same |
| `playerId`, `walletId` | yes | lowercase UUID |
| `roundId`, `gameId` | yes, for every kind | 1–128 of `[A-Za-z0-9._:-]` |
| `kind` | yes | `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` |
| `money` | yes | `MoneyProps`; amount rules V3 and V6 |
| `referenceExternalTransactionId` | `REFUND`, `ROLLBACK`: required; `WIN`, `LOSS`: optional; `BET`: forbidden | same as `externalTransactionId` |

#### Transaction resource (`GET /wagering/transactions/:transactionId` and the provider route)

```text
{
  id, providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind,
  money: MoneyProps, referenceExternalTransactionId?, referenceTransactionId?,
  status, failureCode?, details?, resultBalance: MoneyProps | null,
  attempts, createdAt, processedAt?
}
```

#### Ledger item

```text
{ id, transactionId, direction: "DEBIT" | "CREDIT", amount: MoneyProps,
  balanceBefore: MoneyProps, balanceAfter: MoneyProps, walletVersion, createdAt }
```

#### Routes

Responses are split by kind: "Result" responses carry a resource or the transaction result body, and "Error" responses carry the error envelope.

| Route | Result responses | Error responses |
|---|---|---|
| `POST /wallets` | 201 `{id, playerId, balance, version}`. The server generates a UUIDv7 `id`. `initialBalance` is required and may be `0.00`. | 400; 409 `WALLET_ALREADY_EXISTS` |
| `GET /wallets/:walletId` | 200 `{id, playerId, balance, version}` | 404 |
| `GET /wallets/:walletId/ledger?cursor&limit` | 200 `{items, nextCursor}`, ascending by `wallet_version`. `limit` defaults to 50, maximum 200. The cursor is base64url of `{"v": <last wallet_version>}`. | 400 `INVALID_CURSOR`, 404 |
| `POST /wagering/transactions` | 200, 202, or 422 (transaction result body). `Idempotency-Key` is required. | 400, 404, 409, 503, 500 |
| `GET /wagering/transactions/:transactionId` | 200 (transaction resource) | 404 |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | 200 (transaction resource) | 404 |
| `POST /wallets/:walletId/reconciliation` | 200, even when inconsistent (§14) | 404 |
| `GET /health/live`, `GET /health/ready`, `GET /metrics` | 200 | ready: 503 |

Health and metrics need no authentication (challenge §9). The other routes are open only because authentication is deferred (§16, Risks).

*   **Request headers.**
    *   Every request gets a generated `X-Request-Id`.
    *   An incoming `X-Correlation-Id` is accepted only if it is 1–128 characters from `[A-Za-z0-9._:-]`; otherwise one is generated.
*   **Contention.** Duplicate requests arriving at the same time wait for the wallet lock and then receive the replay of the stored result. There is no "request in progress" response.

### 8. Identities and the payload hash

*   **Three independent identities.**

    | Identity | What it identifies |
    |---|---|
    | `(providerId, idempotencyKey)` | a repeated request |
    | `(providerId, externalTransactionId)` | the financial operation |
    | `(consumerName, envelope messageId)` | an SQS delivery |

    *   The `{providerId}:{externalTransactionId}` key format is recommended, not required.
    *   `consumerName` is the constant `wager-transactions-consumer`.
    *   The SQS-assigned `MessageId` is only logged, as `sqsMessageId`.
*   **SQS message shape** (challenge §10). The body is an envelope:

    ```json
    {
      "messageId": "msg-123",
      "type": "WagerTransactionRequested",
      "occurredAt": "2026-07-29T15:00:00.000Z",
      "data": {
        "providerId": "provider-a",
        "externalTransactionId": "transaction-123",
        "idempotencyKey": "provider-a:transaction-123",
        "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
        "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
        "roundId": "round-987",
        "gameId": "fortune-chimp",
        "kind": "BET",
        "money": { "amount": "25.00", "currency": "BRL" }
      }
    }
    ```

    *   `type` must be `WagerTransactionRequested`.
    *   `data` is the HTTP body (§7) plus a required `idempotencyKey`, which plays the role of the `Idempotency-Key` header.
    *   Unknown fields are rejected at both levels.
*   **Identity decision table.** The use case reads by key first, then by external ID, without a lock, and again under the wallet lock:

    | Key `(providerId, idempotencyKey)` | Stored hash vs incoming | External ID `(providerId, externalTransactionId)` | Result |
    |---|---|---|---|
    | found | equal | (belongs to the same row) | replay of the stored result |
    | found | different | — | `409 IDEMPOTENCY_KEY_CONFLICT` |
    | not found | — | found under another key | `409 EXTERNAL_TRANSACTION_ID_CONFLICT`, even if the payload is identical |
    | not found | — | not found | proceed to the domain checks |
*   **Formats.**
    *   `providerId`, `externalTransactionId`, `roundId`, `gameId`, and the envelope `messageId`: 1–128 characters from `[A-Za-z0-9._:-]`.
    *   `playerId` and `walletId`: canonical lowercase UUIDs.
    *   `Idempotency-Key` (and `data.idempotencyKey`): 1–255 characters in the range 0x21–0x7E.
*   **`payloadHash`.**
    *   **Fields:** the validated `{providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money: {amount, currency}, referenceExternalTransactionId?}`.
    *   **Exclusions:** the key (header or `data.idempotencyKey`), other headers, and the envelope fields. The same operation sent over HTTP and then over SQS with the same key is therefore a replay.
    *   **Algorithm:**
        1. Validate strictly.
        2. Omit absent optional fields; reject an explicit `null`.
        3. Serialize as [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (JCS) canonical JSON in UTF-8. Every value is a string, so this is a recursive key sort followed by `JSON.stringify`.
        4. Hash with SHA-256 and store as `v1:<hex>`. The `v1:` label is static and compared as part of the string; a second algorithm would add dispatch when it exists.
    *   **Tests:** fixed test vectors pin the serialization.
*   **The inbox uses the same hash.**
    *   It stores the message's `payload_hash` and `idempotency_key`.
    *   A repeated `messageId` with the same pair is a duplicate. With a different pair it is `MESSAGE_ID_CONFLICT`.
    *   The inbox handling, including concurrent deliveries of one `messageId`, is in §10.

### 9. Data model

The PostgreSQL version is pinned to 17.

*   **Roles.** The application connects as `wagering_app`, which has only `SELECT`, `INSERT`, and `UPDATE`: it cannot `DELETE`, `TRUNCATE`, alter the schema, or bypass triggers. Grants and triggers are two independent barriers. Migrations run as `wagering_owner`.
*   **Types.** Timestamps are `timestamptz(3)`. Enumerations are `text` columns with `CHECK` constraints.

```mermaid
erDiagram
    wallets ||--o{ wager_transactions : "wallet_id"
    wallets ||--o{ wallet_ledger_entries : "wallet_id"
    wager_transactions ||--o| wallet_ledger_entries : "(transaction_id, wallet_id)"
    wager_transactions ||--o{ wager_transactions : "(reference_transaction_id, wallet_id)"
    wager_transactions ||--o{ inbox : "transaction_id"
    wallets ||--o{ outbox : "wallet_id (group key, no FK)"
```

#### Table `wallets`

*   **Columns:** `id uuid PK`, `player_id uuid`, `currency char(3)`, `balance NUMERIC(14,2)`, `version int`, `created_at`, `updated_at`.
*   **Constraints:**
    *   `UNIQUE (player_id, currency)`;
    *   `CHECK (balance >= 0)`, `CHECK (version >= 1)`, a currency format check.
*   **Triggers:** they block changes to `id`, `player_id`, and `currency`, and block `DELETE`.

#### Table `wager_transactions`

*   **Columns:**
    *   identity: `id`, `provider_id`, `external_transaction_id`, `idempotency_key`, `payload_hash`;
    *   operation: `wallet_id`, `player_id`, `round_id`, `game_id`, `kind`, `amount`, `currency`, `reference_external_transaction_id`, `reference_transaction_id`;
    *   result: `status`, `failure_code`, `result_details jsonb`, `result_balance_amount`, `result_balance_currency`;
    *   tracing and scheduling: `correlation_id`, `attempts`, `next_reference_attempt_at`, `reference_expires_at`;
    *   timestamps: `created_at`, `processed_at`, `updated_at`.
*   **Uniqueness:**
    *   `UNIQUE (provider_id, idempotency_key)`;
    *   `UNIQUE (provider_id, external_transaction_id)`;
    *   `UNIQUE (id, wallet_id)`, the target of the composite foreign keys.
*   **Foreign key:** `(reference_transaction_id, wallet_id) → (id, wallet_id)`. This puts the same-wallet reference rule in the schema.
*   **`CHECK` constraints:**
    *   the `kind` and `status` values, and `status <> 'PENDING'`;
    *   reference presence per kind;
    *   amount sign per kind (`> 0`, except `LOSS`, which is `>= 0`);
    *   `failure_code` present exactly when the status is `REJECTED` or `FAILED`;
    *   the result snapshot required for `PROCESSED` and `REJECTED`;
    *   the scheduling fields required for `PENDING_REFERENCE`;
    *   provider fields null only for `OPENING`.
*   **Partial unique indexes:**
    *   `(reference_transaction_id) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`, which allows one successful reversal;
    *   `(wallet_id) WHERE kind = 'OPENING'`.
*   **Triggers:**
    *   they allow only the persisted lifecycle edges in §4, and only when `NEW IS DISTINCT FROM OLD`;
    *   they block changes to identity columns;
    *   they block `DELETE` and `TRUNCATE`.

#### Table `wallet_ledger_entries`

*   **Columns:** `id`, `wallet_id`, `transaction_id`, `direction`, `amount`, `currency`, `balance_before`, `balance_after`, `wallet_version`, `created_at`.
    *   `wallet_version` is the wallet's version after this entry is applied.
*   **Constraints:**
    *   foreign key `(transaction_id, wallet_id) → wager_transactions (id, wallet_id)`;
    *   `UNIQUE (transaction_id)` and `UNIQUE (wallet_id, wallet_version)`;
    *   `CHECK (amount > 0)` and `CHECK (balance_after >= 0)`;
    *   an arithmetic check: `balance_after = balance_before ± amount`, by direction.
*   **Triggers:** they block `UPDATE`, `DELETE`, and `TRUNCATE`.

#### Commit-time consistency (deferred constraint triggers)

*   **Firing:** `AFTER INSERT OR UPDATE ON wallets` and `AFTER INSERT ON wallet_ledger_entries`, `DEFERRABLE INITIALLY DEFERRED`.
*   **At commit, they check four things.**
    *   **Tip.** Each touched wallet's `balance` and `version` equal its latest entry's `balance_after` and `wallet_version`. With no entries, they must be `0` and `1`.
    *   **Chain.** Each new entry with version `v` continues the previous one, found through `UNIQUE (wallet_id, wallet_version)`:
        *   `v = 1` must be the `OPENING` credit, with `balance_before = 0`;
        *   if entry `v − 1` exists, `balance_before` must equal its `balance_after`;
        *   if `v = 2` and there is no entry 1 (a wallet opened at zero), `balance_before` must be `0`;
        *   any other gap is refused.
    *   **Transaction.** Each new entry's transaction is `PROCESSED`, of a kind that moves the balance, and has the same amount and currency.
    *   **Direction.** The entry's direction matches the kind. For a `ROLLBACK`, it is the opposite of the referenced entry's direction.
*   **What this proves.** With the tip and the chain checked at every commit, "stored balance = sum of the ledger" holds by induction for every write that goes through the triggers. Reconciliation (§14) exists for writes that bypass them.
*   **Why the transaction and direction checks repeat `settle()`.** They make the ledger self-consistent against manual SQL as `wagering_app`, which challenge §5 asks the schema to resist. A41 in Alternatives records the cost.

#### Table `inbox`

*   **Columns:**
    *   `consumer_name`, `message_id`, `payload_hash`, `idempotency_key`, `transaction_id`;
    *   `received_at`: when the row was inserted, in the same transaction as the effect;
    *   `processed_at`: when the row's outcome was committed. For a first delivery both are set in the effect's transaction; for the short replay transaction in §10, both take that transaction's time.
*   **Key:** `PK (consumer_name, message_id)`.
*   **Constraints:** foreign key `transaction_id → wager_transactions (id)`, `DEFERRABLE INITIALLY DEFERRED`, because the inbox row is inserted before its transaction row (§10); `NOT NULL` on every column.
*   **Triggers:** none. Rows are never updated by the application, and `wagering_app` has no `DELETE`.

#### Table `outbox`

*   **Columns:** `id` (= `eventId`), `aggregate_id`, `wallet_id` (the FIFO group key), `event_type`, `event_version`, `payload jsonb`, `occurred_at`, `attempts`, `next_attempt_at`, `published_at`, `last_error`.
*   **Key:** `PK (id)`.
*   **Constraints:** `CHECK (attempts >= 0)`, `CHECK (event_version >= 1)`. No foreign key on `wallet_id`, so an event never blocks on wallet rows.
*   **Triggers:**
    *   `published_at` is write-once: once set, it cannot change or return to `NULL`, so a published event is never reopened;
    *   `id`, `aggregate_id`, `wallet_id`, `event_type`, `event_version`, `payload`, and `occurred_at` are immutable;
    *   `DELETE` and `TRUNCATE` are blocked.

#### Indexes for workers and queries

*   pending rows by `next_reference_attempt_at`;
*   pending rows by `(provider_id, reference_external_transaction_id, wallet_id)`, for the wake-up;
*   unpublished outbox rows by `next_attempt_at`;
*   ledger entries by `(wallet_id, wallet_version)`.

#### Migrations

Handwritten SQL with up and down, run by the MikroORM Migrator. A test runs up, then down, then up. Readiness checks that the latest migration is applied.

### 10. Processing an operation

Rejected alternatives: A4–A6, A39, A40 (locking); A7–A11 (identity).

```mermaid
sequenceDiagram
    participant P as Provider
    participant API as HTTP controller / SQS consumer
    participant UC as SubmitWagerTransaction (via ProcessWagerMessage for SQS)
    participant DB as PostgreSQL
    P->>API: operation (+ Idempotency-Key | envelope)
    API->>API: validate with the shared Zod schemas
    API->>UC: command
    opt SQS only
        UC->>DB: read inbox by (consumer, messageId)
        Note over UC,DB: same pair → ack as duplicate · different pair → DLQ MESSAGE_ID_CONFLICT
    end
    UC->>DB: unlocked lookup by key, then external ID
    Note over UC,DB: terminal → replay (409 if hash differs) · pending → read-only 202
    UC->>UC: generate the transaction ID
    UC->>DB: BEGIN
    UC->>DB: set_config(lock_timeout, transaction_timeout)
    opt SQS only
        UC->>DB: INSERT inbox ON CONFLICT DO NOTHING RETURNING
    end
    UC->>DB: SELECT wallet FOR UPDATE
    UC->>DB: re-read key, external ID, reference, existing reversal
    UC->>UC: settle()
    UC->>DB: write transaction, wallet, ledger, outbox, wake-up
    UC->>DB: COMMIT (deferred triggers check tip, chain, and entries)
    UC-->>API: result
    API-->>P: HTTP response / SQS ack (only after commit)
```

*   **Inbox row before its transaction.** The transaction ID is generated before the unit of work, and the inbox row is inserted with it before the wallet lock, so the inbox key wait still comes first. The inbox foreign key is deferred to commit, when the transaction row exists. If the re-read under the lock finds the operation already stored (another channel committed it between the unlocked lookup and the lock), the unit of work rolls back, and the short SQS replay transaction below records the inbox row with the existing transaction ID.
*   **Inbox insert that inserts nothing.** Two deliveries of one `messageId` can both miss the unlocked inbox read. The second `INSERT … ON CONFLICT DO NOTHING RETURNING` waits for the first to commit and returns no row. The use case then:
    1. re-reads the inbox row, which is committed by now;
    2. if `(payload_hash, idempotency_key)` matches, rolls back and acks as a duplicate (`inbox_duplicates_total`);
    3. if it differs, rolls back and sends the message to the DLQ as `MESSAGE_ID_CONFLICT`.
*   **Unique-constraint races on identities.** A unique violation on `(provider_id, idempotency_key)` or `(provider_id, external_transaction_id)` means another request committed first. The use case rolls back, re-reads once in a new entity-manager fork, and applies the §8 decision table: replay or `409`. This re-read is not one of the contention retries. If the re-read finds nothing, the error is Unexpected (`500`).
*   **Other unique violations.** A violation of `(wallet_id, wallet_version)`, `UNIQUE (transaction_id)` on the ledger, or the one-reversal index cannot happen under the wallet lock. If one occurs, it is Unexpected.
*   **SQS replay.** When the unlocked lookup returns a replay for an SQS message, the consumer records the inbox row in a short transaction, then acknowledges.
*   **Lock-order invariant.**
    *   Every lock taken after the wallet lock is on that wallet's rows or on a newly inserted row.
    *   The inbox primary-key wait happens before the wallet lock.
    *   Therefore no lock cycle can form. A deadlock is still classified as contention, as a safety net.

#### Error classes

| Class | Sources | HTTP | SQS | Worker |
|---|---|---|---|---|
| Contention | `55P03` (lock timeout), `40P01`, `40001`, `57014` (statement timeout), `25P04` (transaction timeout, which also ends the session; the pool discards that connection), pool-acquire timeout | ≤ 2 in-process retries with jitter, then 503 | visibility backoff for this message; DLQ on the 10th receive | skip the item; it stays due |
| Outage | `08xxx`, `53xxx`, `57P01`–`57P03`, SQS network or 5xx | 503 | backoff, and the polling loop skips cycles while that dependency's circuit is open; DLQ on the 10th receive | skip cycles |
| Business | domain rejection; identity races resolved by the re-read above | 422 / 409 (or replay) | ack / DLQ | normal transition |
| Unexpected | anything else, including a re-read that finds nothing | 500 | backoff; DLQ on the 3rd receive | reschedule; `FAILED` only at the TTL |

*   **Retries and circuits.** They use `@nestjs/resilience` policy objects:
    *   a retry policy whose `retryIf` accepts only Contention;
    *   one circuit breaker per dependency (`postgres`, `sqs`) wrapping the infrastructure adapters. A circuit records **only Outage-class errors** as failures, so contention on a hot wallet never opens it.
*   **How a circuit closes again.**
    *   While a circuit is open, the polling loops that need that dependency skip their cycles.
    *   After `openDuration` the circuit is half-open, and each loop runs its normal cycle. That cycle's first call (`ReceiveMessage`, `SendMessageBatch`, or the worker's select) is the probe.
    *   A successful call closes the circuit; a failed one reopens it. This is how the consumer and the publisher notice that SQS is back.
*   **Commit outcome.** If the connection drops during `COMMIT`, the outcome is unknown. The response is 503, and resending with the same key is safe.

#### Connection budget

Each instance has a pool of 21 connections, so three instances use 63 of the 200 that PostgreSQL allows. The shares add up to the pool size:

| Work | Connections | Limited by |
|---|---|---|
| HTTP business requests | 11 | a bulkhead with a bounded queue (`maxQueue` 50, wait at most 2 s, then `503`) |
| SQS consumer | 4 | its design: at most 4 message groups in progress |
| pending-reference worker | 1 | its design: one item at a time |
| outbox publisher | 1 | its design: one batch at a time |
| reconciliation | 2 | a bulkhead with a bounded queue |
| readiness | 1 | a bulkhead |
| `/metrics` gauges | 1 | a bulkhead of its own, so a probe never waits behind a scrape |

*   Bulkheads apply only to work driven from outside the process (HTTP, reconciliation, health and metrics). The internal loops never exceed their share by design.
*   A queued HTTP request holds no connection. `503` means the HTTP share stayed full for 2 s.
*   A hot wallet can still take the whole HTTP share of one instance while its requests wait on the row lock (see Risks). The consumer, the worker, the publisher, reconciliation, readiness, and the gauges keep their own connections.
*   Inside PostgreSQL, the wallet row lock isolates wallets from each other.

#### Time limits

*   PostgreSQL: `statement_timeout`, `lock_timeout`, and `transaction_timeout`, set per connection and per transaction.
*   The connection-pool acquire timeout.
*   The SQS visibility timeout.

The values are in the tuning table in the Detailed Implementation Plan. The guarantee does not rest on them: any overrun or redelivery is a no-op because of the inbox and the identities.

### 11. Pending-reference worker

Rejected alternatives: A18–A21, A34, A38.

1. **Select.** Up to 50 IDs where `status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= now()`, ordered by `next_reference_attempt_at`. Each worker instance starts at a random offset into the first 200 due rows (`random(0, min(200, due) − 1)`, falling back to offset 0 when that selects nothing), so instances start on different rows.
2. **Lock.** For each ID, `BEGIN` and lock its wallet with `FOR UPDATE SKIP LOCKED`.
    *   A busy wallet is skipped. The row's due time is pushed back by 1 s with a conditional `UPDATE … WHERE status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= now()`. That update takes only the transaction row's lock, never the wallet lock, so the lock order holds. `attempts` does not change.
    *   A row at or past its TTL uses a blocking `FOR UPDATE`. If that lock times out, the TTL decision is retried on the next cycle.
3. **Re-check.** Re-read the row using `clock_timestamp()`. Skip it if it is no longer pending, or if `next_reference_attempt_at` is in the future: another worker already handled this backoff window. This re-check replaces a lease and coordinates the worker instances.
4. **Settle.** Call the same `settle()` as submission.
    *   On `Wait`: `attempts = attempts + 1` and `next_reference_attempt_at = min(clock_timestamp() + backoff(attempts), reference_expires_at)`.
    *   On a terminal result: apply the transition and its events.
5. **Backoff.** Base 1 s, cap 5 min, jitter uniform between half the delay and the full delay.
6. **TTL.** 24 h from the first `PENDING_REFERENCE` write, and configurable. The 24 h assumes that providers settle and retry within one day. That is about 290 attempts per row at the cap.
7. <a id="wake-up"></a>**Wake-up.** When the shared persistence step makes a `BET`, `WIN`, or `REFUND` terminal, it sets `next_reference_attempt_at = now()` on pending dependents in the same wallet. It only reschedules them; nothing cascades inline, so the lock stays short. The worker polls at least once a second when idle, so a woken dependent is applied about 1 s later at most.
8. **Errors.**
    *   An infrastructure error pauses the worker without counting an attempt.
    *   An unexpected error before the TTL reschedules the row through an update conditioned on the status and the due time, so one worker reschedules per window.
    *   An unexpected error in the final attempt turns into a `Failed { PROCESSING_FAILED }` result. A new transaction locks the wallet, checks that the row is still pending, and writes that result through the same persistence step as `Rejected`: status `FAILED`, `failure_code`, and the `WagerTransactionFailed` event.

### 12. SQS consumption

Rejected alternatives: A22, A33.

*   **Queues.**
    *   `wager-transactions.fifo`: `VisibilityTimeout` 30 s, configurable for tests.
    *   Native redrive to `wager-transactions-dlq.fifo` at `maxReceiveCount = 50`, well above the application budgets. It is only a backstop for processes that die repeatedly before classifying a message.
    *   `walletId` is the recommended `MessageGroupId`. The provider chooses it. A coarser group, such as one per provider, serializes every wallet in that group (see Risks).
    *   The queue names are fixed by challenge §10. A configurable suffix (`SQS_QUEUE_SUFFIX`) lets the test harness create its own queues (§19).
*   **Receiving and ordering.**
    *   A receive asks for at most as many messages as there are free slots (`MaxNumberOfMessages` = 4 minus the groups in progress). The consumer never holds a message it cannot start.
    *   Each batch is grouped by `MessageGroupId`. Messages of one group run one after another, in the order SQS returned them, and different groups run in parallel. This keeps the provider's order within a wallet: a `BET` sent before a `WIN` cannot overtake it.
    *   When a message is backed off, the messages after it in the same group are released to the queue at once with visibility 0, so SQS delivers the group again in order. After a DLQ move, the failed message is gone, so the rest of the group continues in order on the same consumer.
    *   Before starting each waiting message of a group, the consumer extends its visibility with `ChangeMessageVisibility`, so a long group never lets a waiting message become visible to another instance.
    *   Messages released behind a backed-off message pay one receive each time. They can reach the DLQ as `RETRY_BUDGET_EXHAUSTED` without failing themselves; that reason is safe to redrive (see Risks).
*   **One application DLQ path, `moveToDlq(reason)`.**
    1. Send to the DLQ, reusing the original `MessageGroupId`. `MessageDeduplicationId` is the envelope `messageId` (or the SQS `MessageId` when the envelope is invalid). The message carries the attributes `failureReason`, `receiveCount`, `instanceId`, and `errorClass`.
    2. Delete the message from the source queue.
*   **Budgets,** counted from `ApproximateReceiveCount`:

    | Class | Moved to the DLQ |
    |---|---|
    | Permanent (validation, identity conflict, `MESSAGE_ID_CONFLICT`, `WALLET_NOT_FOUND`) | immediately |
    | Unexpected | on the 3rd receive |
    | Contention or outage | on the 10th receive |

    *   The visibility backoff is `min(2^receiveCount s, 60 s)`. A message under contention backoff blocks its group for about 5 minutes in total before it reaches the DLQ. This is an accepted limit (see Risks).
    *   While the PostgreSQL or SQS circuit is open (§10), the consumer stops receiving, so a long outage does not use up the budgets.
*   **Acknowledgment.**
    *   The consumer acks (deletes) only after commit, for `PROCESSED`, `REJECTED`, and `PENDING_REFERENCE` results and for duplicates.
    *   The inbox row commits with the effect. A redelivery after a crash is therefore a duplicate with no second effect.
*   **Redrive from the DLQ** (operator procedure, documented in `ARCHITECTURE.md`).
    *   **Safe to redrive:** messages whose `failureReason` is `RETRY_BUDGET_EXHAUSTED`, and `UNEXPECTED_ERROR` once its cause is fixed. They are moved back to the input queue unchanged. The inbox and the identities make a redrive either a first application or a duplicate.
    *   **Not to redrive:** permanent reasons (`VALIDATION_FAILED`, identity conflicts, `MESSAGE_ID_CONFLICT`, `WALLET_NOT_FOUND`). Redriving one only repeats the same DLQ move.
*   **Shutdown on `SIGTERM`.**
    1. Abort the in-flight long poll.
    2. Finish the message in progress in each group within the drain time, and release each group's messages that have not started with visibility 0.
    3. The publisher and the worker stop taking work.
    4. Readiness returns 503 while HTTP drains.

    Releasing a message increments its receive count. Shutdown costs at most one receive per released message, which stays inside the budgets.

    This needs `app.enableShutdownHooks()`, an exec-form `CMD` with `init: true`, and `stop_grace_period: 30s`.

### 13. Transactional outbox and integration events

Rejected alternatives: A23–A28.

*   **Publishing cycle.** Each cycle is one short transaction:
    1. Select up to 10 due, unpublished rows with `FOR UPDATE SKIP LOCKED`. Concurrent publishers get disjoint sets.
    2. Send them with `SendMessageBatch`, inside the transaction (`maxAttempts: 1`, 5 s abort).
    3. For each entry, call the domain `OutboxMessage`:
        *   `markPublished(now)` for each successful entry;
        *   `scheduleRetry(now)` for each failed entry, which increments `attempts` and sets the backoff. A sender fault also logs an error and increments `outbox_sender_faults_total`.
    4. Commit.
*   **Polling.** The publisher runs a cycle at least once a second when idle, and immediately again after a full batch.
*   **Whole-call failure.** If the whole call throws, roll back without counting an attempt. The SQS circuit records the failure; while it is open, the publisher skips cycles.
*   **Crash safety.**
    *   A crash mid-send releases the row locks at once, and another instance republishes the same `eventId`.
    *   A failed commit after a successful send causes a later republish, which is a safe duplicate.
    *   A published row is never selected again, and a trigger keeps `published_at` write-once (§9).
*   **No dead-letter for events.** Retries continue forever, with a backoff of base 1 s and cap 5 minutes. An event records an outcome that is already committed, often a balance change, so dropping it would hide that outcome. `outbox_lag_seconds` and `outbox_sender_faults_total` expose stuck events for alerting.
*   **Destination.** `wagering-events.fifo`, with `MessageGroupId = wallet_id` and `MessageDeduplicationId = eventId`, behind the `EventPublisher` port.
    *   FIFO's 5-minute deduplication window absorbs the common duplicate: a republish after a crash.
    *   Consumers still de-duplicate by `eventId`. The guarantee is the stable `eventId`, not the broker.
*   **Event catalog.** Every `data` carries money as `MoneyProps`.

    | Event (v1) | Aggregate | When | `data` |
    |---|---|---|---|
    | `WagerTransactionProcessed` | transaction | any `PROCESSED`, including `LOSS` and `OPENING` | `transactionId`, `providerId?`, `externalTransactionId?`, `walletId`, `playerId`, `kind`, `money`, `balance` (snapshot after the operation), `details?` (for example `referenceReversedBy`) |
    | `WalletBalanceChanged` | wallet | only when the balance moves | as in challenge §11: `walletId`, `transactionId`, `direction`, `money`, `balanceBefore`, `balanceAfter`, `walletVersion` |
    | `WagerTransactionRejected` | transaction | any `REJECTED`, including TTL expiry | `transactionId`, `providerId`, `externalTransactionId`, `walletId`, `playerId`, `kind`, `money`, `failureCode`, `balance` (snapshot), `details?` |
    | `WagerTransactionPendingReference` | transaction | on entering `PENDING_REFERENCE`, once | `transactionId`, `providerId`, `externalTransactionId`, `walletId`, `playerId`, `kind`, `money`, `referenceExternalTransactionId`, `referenceExpiresAt` |
    | `WagerTransactionFailed` | transaction | on `FAILED` (an addition to the challenge's minimum set) | `transactionId`, `providerId`, `externalTransactionId`, `walletId`, `playerId`, `kind`, `money`, `failureCode` (`PROCESSING_FAILED`) |

    A replay emits nothing.
*   **Envelope.** An abstract `IntegrationEvent<T>`, with one subclass per event. Each subclass fixes its `eventType` and `version`. The envelope carries `eventId`, `aggregateId`, `correlationId`, `causationId`, `occurredAt`, and `data`.
    *   `correlationId` is stored on the transaction, so events emitted later by the worker keep it.
    *   `causationId` is what caused the event:
        *   on SQS, the inbound envelope `messageId`;
        *   on HTTP, the `Idempotency-Key`;
        *   in the worker, the pending transaction's own ID.
    *   **Versioning:** an additive field keeps the version. A breaking change bumps it, and both versions are published during the migration.

### 14. Reconciliation

*   **Isolation.** One `REPEATABLE READ READ ONLY` transaction, with no locks and `statement_timeout = 30s`. The result comes from SQL aggregates; no entries are loaded into memory.
*   **Issues.** Core ships `BALANCE_MISMATCH`; the other three are Stretch (task 14).
    *   `BALANCE_MISMATCH`: the stored balance differs from the signed sum of the entries.
    *   `VERSION_MISMATCH`: the stored version differs from the highest `wallet_version`, or from 1 when there are no entries.
    *   `CHAIN_GAP`: the entry count differs from `max − min + 1`, or the lowest version differs from its expected value (1 if an `OPENING` entry exists, else 2).
    *   `CHAIN_BREAK`: the first `balance_before` is not 0, or some `balance_before` differs from the previous entry's `balance_after`.
*   **Response.** The challenge §9 fields, plus `issues`:

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

    *   `difference = stored − calculated`, signed.
    *   `consistent` is true only when `issues` is empty.
    *   Each issue is `{ "code", "details?" }`, for example `{ "code": "CHAIN_GAP", "details": { "missingVersions": [7] } }`.
*   **On divergence:** a warning with the IDs, issue codes, and entry count, but no amounts; and `reconciliation_divergences_total{issue}` is incremented. Data is never corrected.
*   **Scope.** The commit-time triggers (§9) keep every write that goes through them consistent. Reconciliation reports the four issues above when they come from writes that bypass the triggers, such as a superuser, `session_replication_role = replica`, or a partial restore. A rewrite that keeps the balance, the versions, and the chain consistent with each other is not detectable this way.

### 15. Persistence with MikroORM

*   **Records separate from the domain.** Persistence records are defined with `defineEntity` (no decorators) and are separate from the domain classes. Mappers call `rehydrate()` to load and `applyTo()` to write back. The reasons:
    *   ORM hydration bypasses factories, and the challenge requires `rehydrate`;
    *   the domain may not depend on ORM types or decorators;
    *   stale Identity Map state is a concurrency risk, so the use case decides explicitly when state is loaded (after the lock, with `refresh: true`) and when it is written (A29, A30).
*   **What is kept from MikroORM:**
    *   `em.transactional()`;
    *   one ordered `flush()` per transaction;
    *   the Identity Map within a transaction;
    *   `LockMode.PESSIMISTIC_WRITE`.
*   **Entity manager.**
    *   Every read and write uses the entity manager passed to the `em.transactional` callback.
    *   The global context is disabled.
    *   Timeouts are set with `set_config(name, value, true)` on that connection, and a test reads them back with `current_setting`.
*   **One write path per row per transaction.**
    *   Transaction status changes go through the Unit of Work, with `concurrencyCheck` on `status`.
    *   Raw SQL is used only where nothing is loaded: the inbox insert, the outbox selection, the wake-up, the worker's due-time push, and the reconciliation aggregates.
    *   The ORM's `version: true` is not used, because the wallet version is a domain rule.
*   **Types and schema.** Money columns map as `decimal` with a string runtime type. Schema diffing is never run.

### 16. Authentication (documented design, not implemented)

*   **Target design.** Keycloak with OAuth2 client credentials.
    *   The token carries `provider_id`.
    *   A provider may submit operations and read its own transactions.
    *   The `wallet-operator` role creates, reads, and reconciles wallets.
    *   `/metrics` is restricted at the network level.
*   **Errors in that design.**
    *   A missing or invalid token gets `401`.
    *   A role mismatch gets `403`.
    *   A body `providerId` that differs from the token's gets `403 PROVIDER_MISMATCH`.
*   **Code extension point.** One port, `ProviderIdentityPort`, called by the use case. Its current adapter, `TrustAllProviderIdentity`, logs a warning at startup.
*   **SQS.** It stays a trusted internal channel, but its `providerId` passes the same validations.
*   **What is exposed until then** is listed under Risks & Mitigations.

### 17. Runtime topology

*   **Roles.** Environment flags, all on by default: `HTTP_ENABLED`, `SQS_CONSUMER_ENABLED`, `OUTBOX_PUBLISHER_ENABLED`, `REFERENCE_WORKER_ENABLED`.
*   **Instance identity.** `INSTANCE_ID` is a UUID per boot.
*   **Runtime.** The app runs on Bun.
*   **Docker Compose:**
    *   `postgres:17`.
    *   `ministack`, pinned.
    *   A one-shot `setup` service, a Bun script with the AWS SDK, run from the app image. It does this, in order:
        1. run migrations as the owner;
        2. create the application role and its grants;
        3. create the DLQ and read its ARN;
        4. create the input FIFO queue with its `RedrivePolicy`;
        5. create `wagering-events.fifo`.

        It is idempotent. Queue names come from configuration.
    *   `app-1`, `app-2`, and `app-3` under the `app` profile, on ports 3001–3003, with no load balancer.
*   **Tests use their own processes, database, and queues.**
    *   Tests start only `postgres`, `ministack`, and `setup`, and spawn their own app processes.
    *   Tests use their own database (`wagering_test`) and their own queues (a suffix per spec file), created through the same setup routine. So even if the `app` profile is running, its containers never touch test rows, test messages, or test events.
    *   Outages are simulated with a TCP proxy between each spawned process and PostgreSQL or MiniStack (see the test harness in the Detailed Implementation Plan).
*   **Readiness and routing.** Readiness covers PostgreSQL and SQS, as challenge §9 requires.
    *   In this topology nothing routes on readiness, so HTTP keeps serving during an SQS outage (CUJ 6).
    *   A production deployment behind a load balancer would split HTTP readiness from consumer readiness.
*   **Shared machinery.**
    *   One minimal polling loop drives the consumer, the publisher, and the worker. It runs a cycle, waits when idle (at most 1 s), skips cycles while a needed circuit is open, and drains on shutdown.
    *   Retries, circuits, and bulkheads come from `@nestjs/resilience` (§10).
    *   The platform spike checks that this works (task 02; see Risks).
*   **Fault injection.** `FAULT_INJECTION=crash-after-commit` and `crash-after-send` are refused outside `NODE_ENV=test`.

### 18. Observability

*   **Logs.** JSON through a `ConsoleLogger` subclass. An `AsyncLocalStorage` request context adds `correlationId`, `requestId`, `messageId`, `sqsMessageId`, `transactionId`, `walletId`, `providerId`, and `instanceId`. Amounts, balances, and payloads are never logged.
*   **Metrics.** Prometheus format at `/metrics`, via `prom-client`. The seven required categories come first:

    | Category | Metrics |
    |---|---|
    | transactions by status | `wager_transactions_total{kind,status,channel}`, counted after commit |
    | duplicates | `idempotent_replays_total`, `inbox_duplicates_total`, `idempotency_conflicts_total`, `message_id_conflicts_total` |
    | retries | `sqs_retries_total`, `reference_attempts_total`, `outbox_publish_attempts_total` |
    | DLQ | `sqs_dlq_moves_total{reason}`, `sqs_dlq_depth` |
    | lock conflicts | `wallet_lock_wait_seconds`, `wallet_lock_timeouts_total`, `statement_timeouts_total`, `unique_violation_retries_total` |
    | outbox lag | `outbox_lag_seconds` (age of the oldest unpublished event), `outbox_pending`, `outbox_sender_faults_total` |
    | latency | `wager_processing_duration_seconds` |

    *   **Further metrics:**
        *   `pending_references`, `reference_failed_total`;
        *   `reconciliation_divergences_total`; `settlement_on_reversed_reference_total` (Stretch, task 14);
        *   `bulkhead_rejections_total{role}`, `circuit_state{dependency}`;
        *   pool gauges.
    *   **Gauges from the database or the queue** are computed only by instances that run the publisher or the worker. Dashboards use `max` across instances.
*   **Health,** via `@nestjs/terminus`:
    *   `/health/live` checks only the process.
    *   `/health/ready` checks `SELECT 1`, `GetQueueAttributes`, and the latest migration, each with a 1 s timeout. It returns 503 while draining. The response body names the failing dependency.

### 19. Test strategy

| Layer | Location | Infrastructure | Covers |
|---|---|---|---|
| Unit | `src/**` | none | `Money` and the parser, `Wallet`, lifecycle edges, `settle()` for every kind and check, ledger arithmetic, currency mismatch, hash vectors |
| Integration | `test/integration` | real PostgreSQL and MiniStack, one app process or none | migrations up/down/up; every constraint and trigger violated by direct SQL, including a forged ledger chain; atomicity under injected failure; mapper round-trips; inbox and redelivery, including concurrent deliveries of one `messageId`; DLQ classification; per-group ordering; partial batch failure; reconciliation (zero-opened wallet, injected corruption); multi-worker backoff; SIGTERM drain |
| Concurrency | `test/concurrency` | the same, plus three or more processes started with `Bun.spawn` | the eight scenarios in challenge §13; 50 duplicates across processes; a publisher killed mid-send; a long SQS outage; reconciliation during writes; credits near the ceiling; a hot wallet next to quiet wallets |

*   **Rules.**
    *   Missing infrastructure fails the test.
    *   Tests wait on conditions with explicit timeouts, never on sleeps.
    *   Concurrency tests assert distinct PIDs.
    *   Clients retry `503` with the same key.
    *   Isolation comes from unique wallets, providers, and per-run queues, with no cleanup.
    *   Every financial scenario ends with reconciliation of every touched wallet.
*   **Redelivery check.** The surviving process's own `/metrics` shows `inbox_duplicates_total` up by one. The queue, including in-flight messages, and the DLQ are empty. There is one ledger entry and one inbox row.
*   **Consumer contract.** A test-side event reader removes duplicates by `eventId`, as §13 requires of consumers, and asserts that each `eventId` is processed once and that a republished event carries the same `eventId`.

## Risks & Mitigations

Each risk names how it is mitigated, or why it is accepted, and where it is retired: a test, a spike item, or a section.

### Platform spike

The platform spike is the first test written: `test/integration/platform.spec.ts`, in task 02, before any domain persistence. Each item has a pass criterion and a fallback.

| Item | Passes when | Fallback |
|---|---|---|
| MikroORM 7 on Bun with `pg` | `defineEntity`, decimal as string, `PESSIMISTIC_WRITE`, `concurrencyCheck`, raw-SQL migrations up and down, and the Nest 12 module all work | TypeORM (A31); §15 and the persistence files change, the domain and schema do not |
| MiniStack SQS | FIFO group blocking, one receive returning several messages of one group, the deduplication window, `ApproximateReceiveCount`, FIFO-to-FIFO `RedrivePolicy`, `ChangeMessageVisibility` (to 0 and to extend), per-entry `SendMessageBatch` results, and message attributes all behave as in AWS | pin an earlier MiniStack image; if a feature is missing, the affected test asserts the documented AWS behavior through a narrower check, and the gap is listed in `ARCHITECTURE.md` |
| `@nestjs/resilience` 0.0.x on Bun | a retry policy with `retryIf`, a named bulkhead with `maxQueue`, and a circuit breaker with a failure predicate (`recordIf`) and half-open recovery work inside a plain async function | the same three behaviors written in the project behind the same interfaces |
| `transaction_timeout` | it surfaces as SQLSTATE `25P04` and the pool discards the closed connection | treat a closed connection as Contention in the error classifier |
| `prom-client` and Nest source mode on Bun | default metrics register; Nest resolves controller constructor dependencies when Bun runs the source (`start:dev`) | disable default metrics; `start:dev` builds first |

### Risk register

| Risk | Category | Impact | Mitigation or accepted limit | Retired by |
|---|---|---|---|---|
| Any well-formed `providerId` is accepted while authentication is deferred | security | A caller can debit any wallet whose UUID it knows, and can take another provider's external ID first, so the real provider gets `409 EXTERNAL_TRANSACTION_ID_CONFLICT` | Accepted for the challenge. `TrustAllProviderIdentity` logs a warning at startup. The Keycloak design (§16) binds `providerId` to the token. | §16; startup log test |
| Reconciliation and `/metrics` are open | security, load | Reconciliation scans a wallet's ledger with a 30 s statement timeout, so repeated calls load the database | It runs in the reconciliation bulkhead (two connections per instance), so it cannot starve the other roles. `/metrics` is restricted at the network level in the target design. | §10 connection budget |
| Anyone can create `PENDING_REFERENCE` rows by referencing external IDs that never arrive | load | Each row costs about 290 wallet-locking attempts over 24 h | The worker has one connection per instance, and a busy wallet is skipped, not waited on. `pending_references` exposes growth. A per-provider cap belongs to the authentication work. | §11; `pending_references` |
| Writes to one wallet are serialized | scalability | One wallet's throughput is bounded by the time of one transaction under its row lock; a burst waits up to `lock_timeout` and then gets `503`. A burst can take the whole HTTP share of an instance, so other wallets' HTTP requests on that instance queue and may get `503` | Accepted: per-wallet serialization is the correctness mechanism. The HTTP bulkhead keeps the burst from taking the other roles' connections, and contention never opens a circuit. | `balance-contention`, hot-wallet concurrency test |
| Instance count is bounded by `max_connections` | scalability | 21 connections per instance and `max_connections = 200` allow about 9 instances | Accepted at this scale; a connection pooler such as PgBouncer is the documented extension. | tuning table |
| The provider chooses the SQS `MessageGroupId` | scalability | A coarse group (one per provider) serializes every wallet in it; a message under contention backoff blocks its group for about 5 minutes before the DLQ | `walletId` is documented as the recommended group. Group blocking is an accepted cost of FIFO ordering. | §12 |
| Inbox, outbox, ledger, and transaction tables grow without bound | operational | Storage and index size grow; reconciliation time grows with ledger size | Accepted: retention is a non-goal. Ledger checkpoints are a documented future extension. | Non-Goals |
| The commit outcome can be unknown when the connection drops during `COMMIT` | failure mode | The provider cannot tell whether the operation applied | `503`, and resending with the same key is safe: the identities turn a repeat into a replay. | §10; `atomicity` test |
| Writes that bypass the triggers (superuser, `session_replication_role = replica`, partial restore) | failure mode | Ledger and balance can diverge without a commit-time error | Reconciliation reports `BALANCE_MISMATCH` (Core) and the three chain and version issues (Stretch) and never corrects data. | §14; `reconciliation` test |
| Messages waiting behind a failing message in one FIFO group share its receives | failure mode | A valid message can reach the DLQ as `RETRY_BUDGET_EXHAUSTED` without failing itself | Released only on a backoff, never after a DLQ move; that reason is safe to redrive. | §12; `sqs-ordering` test |
| Events are retried forever, with no dead-letter state | failure mode | A poison event is retried every 5 minutes indefinitely | `outbox_lag_seconds` and `outbox_sender_faults_total` expose it for alerting; a stuck event blocks no other event. | §13; `outbox-publisher` test |
| A message lands in the DLQ after its retry budget | operational | A valid operation is not applied until an operator acts | The redrive procedure (§12) lists which reasons are safe to redrive; the inbox makes a redrive safe. | §12 |
| The platform does not behave as assumed (Bun, MikroORM, MiniStack, `@nestjs/resilience`) | platform | Tests or guarantees that depend on the behavior fail | The platform spike above, with a fallback per item. | `platform.spec.ts` |

## Alternatives Considered

Each alternative below was evaluated and rejected by the author. They are grouped by area of the design.

### Money

#### A1: Decimal library (for example `decimal.js`) instead of BigInt minor units

*   **Pros**: It is a familiar API, it handles any scale, and it matches the `Decimal` in the challenge's `Money` skeleton.
*   **Cons**: It is an extra dependency with global configuration (precision and rounding mode) that every context must set the same way. Its silent rounding above the configured precision (20 significant digits by default) does not bite under a 14-digit ceiling, but it is one more setting that has to stay right.
*   **Reason for Rejection**: Rejected by author: BigInt minor units are exact at any magnitude with no configuration. Two fixed decimals fit integer cents, and the string boundary keeps the contract identical.

#### A2: Unconstrained `NUMERIC` with no business maximum

*   **Pros**: There is no limit to justify, and no rejection code for amounts that are too large.
*   **Cons**:
    *   The input still needs a length limit to prevent abuse, so a ceiling exists anyway, only implicitly.
    *   Arithmetic results would have no defined outcome above storage capacity.
    *   "What is the largest balance?" would have no testable answer.
*   **Reason for Rejection**: Rejected by author: instead, an explicit ceiling of `999,999,999,999.99` is used:
    *   `NUMERIC(14,2)` columns enforce it as the last barrier;
    *   input above the ceiling is a validation error;
    *   a credit result above it is `BALANCE_LIMIT_EXCEEDED`.

#### A3: Fixed-scale column as the only scale guard

*   **Pros**: There is no application check to keep in step with the schema.
*   **Cons**: `NUMERIC(p,2)` rounds extra decimals on write instead of rejecting them.
*   **Reason for Rejection**: Rejected by author: the domain parser is the scale guard. The column guards magnitude only, and the documentation says so.

### Concurrency

#### A4: Optimistic locking with a version column and limited retries

*   **Pros**: Nothing waits on a lock, and it fits the `version` field the challenge suggests.
*   **Cons**: On a hot wallet, every conflicting writer redoes the whole decision. The number of retries grows with contention, and the limited retry budget turns contention into failed requests. (The chosen design also fails under heavy contention, with `503` after `lock_timeout`; the difference is that waiting writers do no wasted work.)
*   **Reason for Rejection**: Rejected by author: `SELECT … FOR UPDATE` on the wallet row queues writers per wallet. The queue is bounded by `lock_timeout` (then `503`). Inside PostgreSQL other wallets are unaffected. In each instance a hot wallet can take the whole HTTP share, but the connection budget (§10) keeps it from taking the other roles' connections.

#### A5: Atomic conditional `UPDATE` (`… SET balance = balance - x WHERE balance >= x`)

*   **Pros**: One statement and no explicit lock.
*   **Cons**: It cannot express decisions that read other rows:
    *   the reversal allowance;
    *   the reference's state and amount;
    *   the ledger chain;
    *   the replay snapshot.
*   **Reason for Rejection**: Rejected by author: the decision needs a consistent view of several rows of one wallet, which the row lock provides.

#### A6: Global or advisory lock

*   **Pros**: Simple to reason about.
*   **Cons**: A global lock is forbidden by the challenge and serializes all wallets. A session-level advisory lock is not released by a transaction rollback, and it has no fencing.
*   **Reason for Rejection**: Rejected by author: the per-wallet row lock is scoped to the transaction and released on commit, rollback, or crash. The transaction-scoped advisory lock is A39.

#### A39: Transaction-scoped advisory lock (`pg_advisory_xact_lock(hash(walletId))`)

*   **Pros**: It is released on commit or rollback like a row lock, and it can serialize a wallet before the wallet row exists.
*   **Cons**:
    *   Hash collisions serialize unrelated wallets.
    *   It protects nothing by itself: the wallet row still has to be read after the lock, and code that forgets the advisory lock is not blocked by anything.
*   **Reason for Rejection**: Rejected by author: the wallet row lock serializes exactly the row whose balance changes, and every wallet exists before any operation on it.

#### A40: `SERIALIZABLE` isolation with bounded retries

*   **Pros**: PostgreSQL detects every anomaly, with no explicit lock.
*   **Cons**:
    *   On a hot wallet, serialization failures (`40001`) grow with contention, and each retry repeats the whole decision, the same weakness as A4.
    *   The guarantee depends on every transaction running at that level, including the worker and manual SQL.
*   **Reason for Rejection**: Rejected by author: an explicit row lock under `READ COMMITTED`, with every read repeated after the lock. `40001` is still classified as contention in case it appears.

### Idempotency and identity

#### A7: A new idempotency key may re-execute an existing external transaction

*   **Pros**: A provider can retry a rejected operation by changing the key.
*   **Cons**: The same provider operation could move money twice.
*   **Reason for Rejection**: Rejected by author: `(providerId, externalTransactionId)` is unique on its own. A new key on an existing external ID returns `409 EXTERNAL_TRANSACTION_ID_CONFLICT`.

#### A8: External-ID uniqueness only among rows with an effect, so rejected operations can be retried under the same external ID

*   **Pros**: A provider can retry a rejected operation, or one whose reference expired, without a new external ID.
*   **Cons**:
    *   One external ID could map to several rows, which makes reference resolution and `GET /providers/…/:externalTransactionId` ambiguous.
    *   A simple unique constraint would become a status-dependent index whose correctness depends on every status write being right.
*   **Reason for Rejection**: Rejected by author: a terminal result is final for its external ID. Each failure code states the provider's next action, including "resend under a new external ID".

#### A9: Two hashes, a business `payloadHash` plus a separate inbox `messageHash`

*   **Pros**: Transport identity and operation identity are checked independently.
*   **Cons**: Under strict schemas, with a single accepted message `type`, the second hash differs exactly when `(payloadHash, idempotencyKey)` differs. That means a second algorithm and a second set of test vectors for no extra protection.
*   **Reason for Rejection**: Rejected by author: the inbox stores and compares `payload_hash` and `idempotency_key`, matching the challenge's `InboxMessage.payloadHash`.

#### A10: Use `@nestjs/idempotency`

*   **Pros**: It is first-party and handles keys, fingerprints, and in-flight duplicates.
*   **Cons**:
    *   Its records are written outside the business transaction, so a crash between the business commit and the record write breaks atomicity.
    *   It answers a reused key with `422`, while this design reserves `422` for business rejections.
    *   It has no MikroORM store.
*   **Reason for Rejection**: Rejected by author: idempotency lives in the same SQL transaction as the effect, enforced by unique constraints.

#### A11: Accept number-like and lenient amounts (`"25"`, `"25.5"`) and normalize them

*   **Pros**: It is tolerant of provider formatting.
*   **Cons**:
    *   It breaks the two-decimal contract.
    *   Different spellings of the same amount would hash differently and produce false conflicts.
*   **Reason for Rejection**: Rejected by author: one strict grammar, and no normalization before hashing.

### Business rules

#### A12: Allow one successful `REFUND` and one successful `ROLLBACK` on the same transaction (reading "the same type" literally)

*   **Pros**: It is the most literal reading of the challenge text.
*   **Cons**: A `BET` that is refunded and then rolled back returns the stake twice.
*   **Reason for Rejection**: Rejected by author: at most one successful direct reversal per transaction, across both kinds, enforced by a partial unique index. A rejected attempt does not consume the allowance.

#### A13: Reject a `WIN` or `LOSS` that references an already-reversed `BET`

*   **Pros**: It blocks paying a prize on a cancelled stake when the reference is supplied.
*   **Cons**:
    *   A `WIN` without a reference still passes, so the protection is partial.
    *   The outcome depends on arrival order: `REFUND → WIN` blocks the prize, but `WIN → REFUND` pays both, unless an additional rule, not in the challenge, forbids refunding a settled `BET`.
    *   The challenge defines no round state.
*   **Reason for Rejection**: Rejected by author: the operation is processed and flagged with `details.referenceReversedBy` and a warning log; a counter is Stretch (task 14). The outcome is independent of order, and round coherence is the provider's responsibility.

#### A14: `LOSS` must be `0.00` and must not carry a reference

*   **Pros**: There is no informational amount to misread.
*   **Cons**: The challenge says only that `LOSS` records the result without moving the balance. A provider that sends the stake, or the `BET` reference, would get `400` or a DLQ entry.
*   **Reason for Rejection**: Rejected by author: any non-negative amount, which is informational, and an optional `BET` reference under the `WIN` rules.

#### A15: Persist a rejection for an unknown wallet, so the replay is stable

*   **Pros**: Every submission leaves a row.
*   **Cons**: `wager_transactions.wallet_id` could then not carry a foreign key, which weakens a schema guarantee.
*   **Reason for Rejection**: Rejected by author: `404 WALLET_NOT_FOUND`, not persisted, on every endpoint. Wallet IDs are generated by the server, so the request can never later succeed with that ID.

#### A16: `422` for an unknown wallet on `POST /wagering/transactions`

*   **Pros**: It frames the case as a business problem.
*   **Cons**: `422` would mean two things with two body shapes: a persisted, final transaction result, and an unpersisted error.
*   **Reason for Rejection**: Rejected by author: `422` always means a persisted transaction result, and an unknown wallet is `404` everywhere.

#### A17: Return `200` with `status: REJECTED` for business rejections

*   **Pros**: The request was handled, so a success status can be argued.
*   **Cons**: Accepted and rejected outcomes share a status, and the challenge asks that providers not need the body to decide whether to resend.
*   **Reason for Rejection**: Rejected by author: `422`, with the same transaction body.

### Pending references

#### A18: Resolve dependents inline, as a cascade, when a reference arrives

*   **Pros**: Dependents resolve with no delay.
*   **Cons**: One submission can hold the wallet lock for an unbounded chain of dependents.
*   **Reason for Rejection**: Rejected by author: the wake-up only reschedules dependents (`next_reference_attempt_at = now()`), and the worker applies them on its next cycle (at most about 1 s when idle).

#### A19: A claim or lease column for pending-reference work

*   **Pros**: Explicit ownership of each pending row.
*   **Cons**: It adds columns, expiry handling, and stale-owner cases.
*   **Reason for Rejection**: Rejected by author: re-reading the row and its due time under the wallet lock gives one attempt per backoff window with no extra state.

#### A20: Mark `FAILED` after N consecutive unexpected errors

*   **Pros**: A broken row stops being retried quickly.
*   **Cons**:
    *   The counter races between workers.
    *   It needs a reset rule.
    *   A misclassified transient error can fail a valid reversal within seconds, and because a result is final per external ID, the reversal could never be retried.
*   **Reason for Rejection**: Rejected by author: unexpected errors are rescheduled with the normal backoff. `FAILED` is written only if the final attempt at the TTL still throws. The TTL is the single deadline for every terminal outcome.

#### A21: An attempt-count limit instead of a TTL

*   **Pros**: It is easy to count.
*   **Cons**: Its meaning in wall-clock time depends on the backoff and the number of workers, while a provider's settlement horizon is a time window.
*   **Reason for Rejection**: Rejected by author: a 24-hour TTL, configurable, with attempts persisted for observability.

### Messaging

#### A22: Two DLQ paths: an application move for permanent failures, native redrive for everything else

*   **Pros**: Less application code.
*   **Cons**:
    *   Native redrive is invisible to the application, so DLQ metrics undercount and entries have no reason attribute.
    *   A deterministic bug blocks its wallet's FIFO group for about 18 minutes (10 receives with backoff up to 5 minutes).
*   **Reason for Rejection**: Rejected by author: one application path with budgets per error class (immediate, 3rd receive, 10th receive), a 60 s backoff cap, and native redrive at 15 only as a crash-loop backstop.

#### A23: Outbox lease with a per-claim token, and sending outside any transaction

*   **Pros**:
    *   No connection is held during the network call.
    *   A minimal lease needs no new columns: a short `SKIP LOCKED` claim sets `next_attempt_at = now() + 30 s`, the send happens outside any transaction, and `markPublished` is guarded by `published_at IS NULL`. A stale owner's `markPublished` is still correct, because its send succeeded.
*   **Cons**: After a publisher crash, its claimed rows wait up to the lease interval (30 s) before another instance republishes them.
*   **Reason for Rejection**: Rejected by author: the real trade-off is that delay against one connection held in a transaction for up to 5 s per publisher during SQS slowness. The chosen design (one short transaction with `FOR UPDATE SKIP LOCKED`, sending inside it and recording each entry through `OutboxMessage.markPublished` / `scheduleRetry`) releases the locks at once on a crash, and the connection budget reserves the publisher's connection (§10).

#### A24: A dead-letter state for outbox events after N attempts

*   **Pros**: Poison events stop being retried.
*   **Cons**:
    *   A committed event records an outcome that is already committed, often a balance change, and parking it hides that from every consumer until someone requeues it by hand.
    *   An outage longer than the attempt budget would park every event.
*   **Reason for Rejection**: Rejected by author: events are retried forever with a 5-minute cap, and `outbox_lag_seconds` and `outbox_sender_faults_total` expose stuck events for alerting. Because ordering is not promised, a stuck event blocks no other event.

#### A25: Per-key ordered publication (one in-flight event per wallet)

*   **Pros**: Consumers see events in commit order.
*   **Cons**: One failing event blocks every later event for that wallet.
*   **Reason for Rejection**: Rejected by author: there is no ordering promise. `WalletBalanceChanged` carries `walletVersion`, so consumers order or discard events themselves.

#### A26: A standard SQS queue for integration events instead of FIFO

*   **Pros**: Higher throughput, and no group blocking for consumers.
*   **Cons**: It loses the 5-minute deduplication window that absorbs the most common duplicate, a republish after a crash.
*   **Reason for Rejection**: Rejected by author: FIFO costs no extra code, because the group and deduplication IDs already exist.

#### A27: SNS topic with subscribed queues

*   **Pros**: It fans one event out to many consumers without changing the publisher.
*   **Cons**: Another emulated service and another hop in every test, and the challenge has no event consumer.
*   **Reason for Rejection**: Rejected by author: a single queue behind the `EventPublisher` port. SNS is a documented future extension that needs only a new adapter.

#### A28: Use `@nestjs/outbox`

*   **Pros**:
    *   It is first-party.
    *   It writes in the business transaction.
    *   It provides leases, retries, and dead letters.
*   **Cons**:
    *   It has no MikroORM executor and no SQS transport.
    *   It brings its own schema, and it would replace the domain `OutboxMessage` the challenge asks for.
*   **Reason for Rejection**: Rejected by author: the outbox is part of the project's own domain and schema.

### Persistence and runtime

#### A29: Map domain classes directly as MikroORM entities

*   **Pros**: Less code, and the Unit of Work tracks domain objects directly.
*   **Cons**:
    *   Hydration bypasses constructors and factories, so `rehydrate` would never run.
    *   The ORM would depend on private field names, and `Money` would need an ORM custom type.
    *   Implicit flushes of objects loaded before a lock wait could persist stale state.
*   **Reason for Rejection**: Rejected by author: separate persistence records with explicit mappers.

#### A30: MikroORM `version: true` optimistic locking on wallets

*   **Pros**: A second guard against lost updates.
*   **Cons**: The ORM increments the version on every update, but the domain rule is that the version changes only with the balance.
*   **Reason for Rejection**: Rejected by author: the row lock and the commit-time trigger guard the wallet. `concurrencyCheck` on transaction `status` guards worker transitions.

#### A31: TypeORM

*   **Pros**: The challenge accepts it, and it has a first-party Nest package (`@nestjs/typeorm`).
*   **Cons**: The challenge prefers MikroORM's explicit Unit of Work, Identity Map, and `transactional()`.
*   **Reason for Rejection**: Rejected by author: MikroORM. TypeORM remains the fallback if the platform spike (task 02: a test that checks MikroORM, MiniStack, and `@nestjs/resilience` on Bun; see Risks & Mitigations) shows MikroORM failing on Bun. In that case §15 and the persistence file names change; the domain, the schema, and the use cases do not.

#### A32: Run migrations at application startup

*   **Pros**: One less service in Compose.
*   **Cons**: Three instances starting together would race for the same migration.
*   **Reason for Rejection**: Rejected by author: a one-shot `setup` service runs migrations and creates the queues before any instance starts.

#### A33: LocalStack instead of MiniStack

*   **Pros**: It is an established AWS emulator with broad SQS coverage.
*   **Cons**: At the time of writing, its current images require an account auth token to start, and the evaluators must run everything with Docker alone and no account.
*   **Reason for Rejection**: Rejected by author: MiniStack, pinned. Its SQS features are checked in the platform spike.

#### A34: `@nestjs/locks` for worker coordination

*   **Pros**: It is first-party and provides fencing tokens.
*   **Cons**: Its locks live outside the business transaction, and it adds a store.
*   **Reason for Rejection**: Rejected by author: the per-wallet row lock, the due-time re-check, and `SKIP LOCKED` cover every coordination need.

#### A38: `@nestjs/schedule` for the worker and publisher loops

*   **Pros**: It is first-party, with `@Interval()` and a `SchedulerRegistry`.
*   **Cons**: Its documentation describes no backoff or dynamic delay for intervals, no pause and resume, no overlap prevention for intervals (only `waitForCompletion` for cron jobs), and no waiting for a running job at shutdown. The loops need all four.
*   **Reason for Rejection**: Rejected by author: a minimal polling loop (cycle, idle wait, drain) with circuits from `@nestjs/resilience` deciding when to skip cycles.

#### A41: Keep only the tip and chain checks in the commit-time trigger

*   **Pros**: The kind-to-direction table and the `ROLLBACK` inversion would live only in `settle()`, so there would be one implementation to change and test.
*   **Cons**: A manual SQL write as `wagering_app` could record a `BET` as a credit, or a `ROLLBACK` in the same direction as its reference, and the schema would accept it as long as the arithmetic and the chain held.
*   **Reason for Rejection**: Rejected by author: the trigger keeps the transaction and direction checks. The duplicated rules are short, fixed by the challenge, and covered by the schema-constraint tests, and they make the ledger self-consistent against manual SQL (challenge §5).

#### A42: `NodeAdapter` (`@nestjs/platform-node`) instead of Express

*   **Pros**: It is the fastest first-party HTTP adapter.
*   **Cons**: The challenge sets no throughput target, Express is already wired, and the swap adds a platform risk on Bun with its own fallback.
*   **Reason for Rejection**: Rejected by author: keep `@nestjs/platform-express`. Revisit only if load testing shows the adapter matters.

### Observability and authentication

#### A35: NestJS Observe for telemetry

*   **Pros**: It is first-party, with traces, errors, and metrics.
*   **Cons**: It needs an account and sends data outside the evaluator's machine.
*   **Reason for Rejection**: Rejected by author: Prometheus metrics through `prom-client`, and JSON logs.

#### A36: Implement Keycloak authentication

*   **Pros**: Provider identity would be enforced.
*   **Cons**:
    *   It is worth no points.
    *   It adds a container of about 500 MB that takes about 30 s to start.
    *   Every multi-process test would need tokens.
*   **Reason for Rejection**: Rejected by author: the design is documented. One `ProviderIdentityPort` is the extension point.

#### A37: A `KNOWN_PROVIDERS` allowlist as a stand-in for authentication

*   **Pros**: Unknown providers would be rejected.
*   **Cons**: It is static configuration that needs a restart for every new provider, and it does not authenticate anyone.
*   **Reason for Rejection**: Rejected by author: accepting any well-formed `providerId` is a documented limitation of deferring authentication.

## Detailed Implementation Plan

This plan lists every file or file group the implementation creates, changes, or deletes, plus the board-card edits in task 01. It follows the 13 tasks of the [project board](https://github.com/users/joaoalberto-dev/projects/3) in order, and adds a final Stretch task (14). The task headings below are the board cards. Everything outside task 14 is Core: it serves a rubric item or a mandatory test. Each task ends with a "Done when" line made of named tests or checks. Production code is not included; TypeScript signatures, SQL fragments, and JSON appear only where they remove a decision. "§N" refers to this document and "challenge §N" to `CHALLENGE.md`.

### Settled implementation choices

Each row fixes a choice the implementer would otherwise make. Versions are exact pins for `package.json`; the platform spike may move a pin within the same line.

| Question | Decision | Reason |
|---|---|---|
| Folder layout | `src/domain`, `src/application`, `src/contracts`, `src/infrastructure`, `src/interface`, `src/bootstrap`; `migrations/` and `scripts/` at the root | One bounded context; layer folders make the dependency rule visible and lintable. `contracts` holds the inbound schemas shared by the HTTP controllers and the SQS consumer. |
| MikroORM | `@mikro-orm/core`, `@mikro-orm/postgresql`, `@mikro-orm/migrations` `7.2.8`; `@mikro-orm/nestjs` `7.1.0` | `@mikro-orm/nestjs` 6.x supports only Nest 10 and 11; 7.1.0 declares `^12.0.0`. Fallback: TypeORM (A31). |
| Migration runner | `scripts/migrate.ts` using the MikroORM `Migrator` API; no `@mikro-orm/cli` | One less dependency; the same function serves `setup`, the npm scripts, and the test harness. |
| Validation | `zod` `4.6.7` | Implements Standard Schema, which `StandardSchemaValidationPipe` consumes. |
| HTTP adapter | Keep `@nestjs/platform-express` (already installed) | No throughput target (A42). |
| Retries, circuits, bulkheads | `@nestjs/resilience` `0.0.3` | First-party and declares Nest 12. Fallback: the same three behaviors written in the project behind the same interfaces. |
| Health | `@nestjs/terminus` `12.1.0` | First-party; declares `^11 \|\| ^12`. |
| SQS | `@aws-sdk/client-sqs` `3.1167.0` | Official client; works against MiniStack through `AWS_ENDPOINT_URL`. |
| Metrics | `prom-client` `15.1.3` | Prometheus text format. |
| Images | `postgres:17.11`, `ministackorg/ministack:1.5.39`, `oven/bun:1.4.4` | Pinned for reproducibility; the spike confirms MiniStack's SQS behavior on this tag. |
| Migration naming | `migrations/NNNN-kebab-description.ts`, one class `MigrationNNNN<PascalDescription>` per file, handwritten SQL in `up()` and `down()`; `migrations/index.ts` exports the ordered list and `LATEST_MIGRATION` | Explicit order; readiness compares against `LATEST_MIGRATION`. |
| Configuration | One Zod schema parsed from `process.env` into a frozen `AppConfig`; no `@nestjs/config` | The setup script and the test harness read the same configuration without Nest. |
| Canonical JSON | Written in the project (recursive key sort, then `JSON.stringify`) | Every hashed value is a string. |
| Runtime | `nest build` (tsc, emits decorator metadata), then `bun dist/bootstrap/main.js` in production and in tests; `start:dev` runs the source | Avoids depending on Bun's decorator-metadata emit outside development. |
| Composition | `src/bootstrap/container.ts` exports `buildApplication(config, overrides?)`, a plain function that builds every port adapter and use case; Nest modules only expose its results | In-process tests build the same graph with failing adapters, without Nest. |

### Dependency rule

```text
domain  ◄──  application  ◄──  infrastructure ──►  contracts
                  ▲                                    ▲
                  └──────────  interface  ─────────────┘
bootstrap imports everything and wires it
```

*   `src/domain` imports only other `src/domain` files and `node:crypto`.
*   `src/application` imports only `src/domain` and `node:crypto`. Use cases carry no Nest decorators. Ports are TypeScript interfaces, each with a `Symbol` token exported next to it.
*   `src/contracts` imports only `zod`.
*   `src/infrastructure` and `src/interface` import `src/domain`, `src/application`, and `src/contracts`, never each other. The SQS consumer is an inbound adapter in `src/infrastructure/messaging`. Health and metrics controllers are operational endpoints in `src/infrastructure/observability`.
*   Bulkheads are applied by `src/bootstrap` through a global interceptor keyed by route group, so controllers import no resilience policy. Circuits wrap the infrastructure adapters.
*   Specs (`*.spec.ts`) may also import `bun:test`.

`.oxlintrc.json` after task 02 (the existing `rules` stay; `plugins` must list `typescript` again because setting `plugins` replaces the default set):

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["typescript", "unicorn", "oxc", "import"],
  "options": { "typeAware": true },
  "categories": { "correctness": "error" },
  "rules": { "import/no-cycle": "error", "...": "the existing rules unchanged" },
  "overrides": [
    {
      "files": ["src/domain/**/*.ts"],
      "excludeFiles": ["**/*.spec.ts"],
      "rules": { "no-restricted-imports": ["error", { "patterns": [
        { "group": ["**/application/**", "**/contracts/**", "**/infrastructure/**", "**/interface/**", "**/bootstrap/**"], "message": "domain imports only domain" },
        { "group": ["@*/*", "zod", "prom-client", "node:*", "!node:crypto"], "message": "domain imports no packages except node:crypto" }
      ] }] }
    },
    {
      "files": ["src/application/**/*.ts"],
      "excludeFiles": ["**/*.spec.ts"],
      "rules": { "no-restricted-imports": ["error", { "patterns": [
        { "group": ["**/contracts/**", "**/infrastructure/**", "**/interface/**", "**/bootstrap/**"], "message": "application imports only domain" },
        { "group": ["@*/*", "zod", "prom-client", "node:*", "!node:crypto"], "message": "application imports no packages except node:crypto" }
      ] }] }
    },
    {
      "files": ["src/contracts/**/*.ts"],
      "excludeFiles": ["**/*.spec.ts"],
      "rules": { "no-restricted-imports": ["error", { "patterns": [
        { "group": ["**/domain/**", "**/application/**", "**/infrastructure/**", "**/interface/**", "**/bootstrap/**"], "message": "contracts import only zod" }
      ] }] }
    },
    {
      "files": ["src/interface/**/*.ts"],
      "rules": { "no-restricted-imports": ["error", { "patterns": [
        { "group": ["**/infrastructure/**", "**/bootstrap/**"], "message": "interface reaches infrastructure through ports" }
      ] }] }
    },
    {
      "files": ["src/infrastructure/**/*.ts"],
      "rules": { "no-restricted-imports": ["error", { "patterns": [
        { "group": ["**/interface/**", "**/bootstrap/**"], "message": "infrastructure does not import interface" }
      ] }] }
    }
  ]
}
```

The `"..."` key stands for the 13 existing rules, copied unchanged. The lint check in task 02 proves that a deliberate violation in each layer is reported.

### Configuration (environment variables)

| Variable | Default | Used by | Notes |
|---|---|---|---|
| `NODE_ENV` | `production` | config | `FAULT_INJECTION` requires `test` |
| `PORT` | `3000` | HTTP server | tests pass a free port |
| `INSTANCE_ID` | a new UUID per boot | logs, DLQ attributes | |
| `DATABASE_URL` | `postgres://wagering_app:wagering_app@localhost:5432/wagering` | app | the setup script derives the app role's name and password from it |
| `DATABASE_OWNER_URL` | `postgres://wagering_owner:wagering_owner@localhost:5432/wagering` | setup, migrations | |
| `DATABASE_POOL_MAX` | `20` | app | |
| `DB_LOCK_TIMEOUT_MS` | `2000` | unit of work | tests shorten it |
| `AWS_REGION`, `AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `us-east-1`, `http://localhost:4566`, `test`, `test` | SQS client | MiniStack accepts any credentials |
| `SQS_QUEUE_SUFFIX` | empty | setup, consumer, publisher | inserted before `.fifo` in the three fixed queue names |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | `30` | setup, consumer | tests shorten it |
| `SQS_BACKOFF_BASE_MS`, `SQS_BACKOFF_CAP_MS` | `2000`, `60000` | consumer | tests shorten them |
| `HTTP_BULKHEAD_SIZE`, `HTTP_BULKHEAD_QUEUE` | `11`, `50` | HTTP interceptor | tests shrink them to fill the bulkhead deterministically |
| `HTTP_ENABLED`, `SQS_CONSUMER_ENABLED`, `OUTBOX_PUBLISHER_ENABLED`, `REFERENCE_WORKER_ENABLED` | `true` | bootstrap | see Role flags |
| `REFERENCE_TTL_SECONDS` | `86400` | worker | tests shorten it |
| `LOG_LEVEL` | `log` | logger | |
| `FAULT_INJECTION` | unset | fault points | comma-separated: `crash-after-commit`, `crash-after-send`, `unexpected-on-wallet:<walletId>` |

The defaults are the compose values, so a fresh clone needs no `.env`. `.env.example` lists every variable for reference.

**Role flags.** The HTTP server always listens and always serves `/health/*` and `/metrics`. `HTTP_ENABLED` controls only the wallet and wagering controllers. The other three flags decide which polling loops `src/bootstrap/workers.module.ts` and `messaging.module.ts` start.

### Tuning values

This table is authoritative. Values written elsewhere in this document must match it.

| Area | Value |
|---|---|
| PostgreSQL | `statement_timeout` 5 s per connection; `lock_timeout` 2 s and `transaction_timeout` 10 s per transaction; reconciliation `statement_timeout` 30 s and `transaction_timeout` 35 s |
| Connection pool | 21 per instance; acquire timeout 2 s; compose `max_connections = 200` |
| Shares | HTTP 11 (bulkhead, `maxQueue` 50, queue wait 2 s); consumer 4; worker 1; publisher 1; reconciliation 2 (bulkhead, `maxQueue` 10, queue wait 2 s); readiness 1 (bulkhead, `maxQueue` 5, queue wait 1 s); `/metrics` gauges 1 (bulkhead, `maxQueue` 2, queue wait 1 s) |
| HTTP | contention retry: 3 attempts in total, `full` jitter, base 50 ms; `Retry-After: 1` on every `503` |
| Circuit breakers | one per dependency; open after 5 consecutive Outage failures; `openDuration` 5 s; `halfOpenMaxCalls` 1 |
| SQS consumer | visibility 30 s; long poll 20 s; at most 4 groups in progress; backoff `min(base · 2^(receiveCount − 1), cap)` with base 2 s and cap 60 s; budgets 3 (unexpected) and 10 (contention, outage); native redrive at 50; SIGTERM drain 20 s; compose `stop_grace_period` 30 s |
| Outbox publisher | batch 10; idle poll 500 ms; send abort 5 s; retry backoff `base · 2^(attempts − 1)` with base 1 s, cap 5 min, jitter in `[delay/2, delay]` |
| Pending-reference worker | batch 50 from a random offset into the first 200 due rows; idle poll 500 ms; busy-wallet push 1 s; backoff base 1 s, cap 5 min, same formula and jitter; TTL 24 h |
| Health | each readiness check 1 s |
| Metrics | latency histogram buckets 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5 s |

### Port contracts

All ports live in `src/application/ports/`, one file per port, each exporting the interface and its `Symbol` token. Types such as `Money`, `Wallet`, and `WagerTransaction` are the domain classes.

```ts
// unit-of-work.ts
interface UnitOfWork {
  run<T>(fn: (tx: TxContext) => Promise<T>, opts: {
    retryContention: boolean;                 // true only for HTTP
    mode?: 'write' | 'read-only-snapshot';    // snapshot = REPEATABLE READ READ ONLY (reconciliation)
  }): Promise<T>;
}
interface TxContext {
  wallets: WalletRepository; transactions: TransactionRepository;
  ledger: LedgerRepository; inbox: InboxRepository; outbox: OutboxRepository;
  reconciliation: ReconciliationReader;
}

// repositories.ts
interface WalletRepository {
  lock(id: string, mode: 'wait' | 'skip-locked'): Promise<Wallet | null>;   // SELECT … FOR UPDATE [SKIP LOCKED], refresh
  findById(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  save(wallet: Wallet): Promise<void>;
}
interface TransactionRepository {
  findByKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalId: string): Promise<WagerTransaction | null>;
  findById(id: string): Promise<WagerTransaction | null>;
  findSuccessfulReversal(referenceTransactionId: string): Promise<WagerTransaction | null>;
  insert(t: WagerTransaction, pending?: { backoffMs: number; ttlMs: number }): Promise<{ referenceExpiresAt?: Date }>;
    // pending: next_reference_attempt_at = clock_timestamp() + backoff, reference_expires_at = clock_timestamp() + ttl, RETURNING
  save(t: WagerTransaction): Promise<void>;                          // Unit of Work, concurrencyCheck on status
  reschedule(id: string, backoffMs: number): Promise<boolean>;       // raw SQL, conditional on status and due time; attempts + 1
  pushBack(id: string, delayMs: number): Promise<boolean>;           // raw SQL, conditional; attempts unchanged; no wallet lock
  wakeDependents(walletId: string, providerId: string, externalId: string): Promise<number>;  // raw SQL
  selectDue(limit: number, maxOffset: number): Promise<string[]>;    // ids, ordered by due time, random offset
  recheck(id: string): Promise<{ due: boolean; ttlReached: boolean } | null>;  // clock_timestamp()
}
interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null>;
}
interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  insertIfAbsent(message: InboxMessage): Promise<boolean>;           // ON CONFLICT DO NOTHING RETURNING
}
interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;
  claimDue(limit: number): Promise<OutboxMessage[]>;                 // FOR UPDATE SKIP LOCKED
  markPublished(ids: string[]): Promise<void>;                        // published_at = clock_timestamp()
  scheduleRetry(id: string, backoffMs: number, error: string): Promise<void>;
}
interface ReconciliationReader {
  aggregate(walletId: string): Promise<{
    storedBalance: string; currency: string; storedVersion: number;
    ledgerSumMinor: bigint; entryCount: number;
    minVersion: number | null; maxVersion: number | null; hasOpening: boolean;
    firstBalanceBefore: string | null; chainBreaks: number;
  } | null>;
}

// queries.ts (read side, no lock; one short read-only transaction each)
interface QueryPort {
  wallet(id: string): Promise<WalletView | null>;
  ledgerPage(walletId: string, afterVersion: number, limit: number): Promise<LedgerItemView[]>;
  transaction(id: string): Promise<TransactionView | null>;
  transactionByExternalId(providerId: string, externalId: string): Promise<TransactionView | null>;
}

// other ports
interface EventPublisher {
  publishBatch(entries: { id: string; groupId: string; body: string }[]):
    Promise<{ id: string; ok: boolean; senderFault: boolean; error?: string }[]>;
}
interface ProviderIdentityPort { authorize(providerId: string, channel: 'http' | 'sqs'): Promise<void>; }
interface Clock { now(): Date; }
interface IdGenerator { uuidv7(): string; }
interface RequestContext {
  run<T>(fields: Partial<LogFields>, fn: () => Promise<T>): Promise<T>;
  get(): LogFields;
  set(fields: Partial<LogFields>): void;
}
interface Telemetry {   // one method per metric the application raises; adapters own the rest (metric table)
  transactionDecided(kind: string, status: string, channel: 'http' | 'sqs' | 'worker'): void;
  processingDuration(channel: string, seconds: number): void;
  idempotentReplay(channel: string): void;
  idempotencyConflict(code: 'IDEMPOTENCY_KEY_CONFLICT' | 'EXTERNAL_TRANSACTION_ID_CONFLICT'): void;
  inboxDuplicate(): void;
  messageIdConflict(): void;
  uniqueViolationRetry(): void;
  referenceAttempt(outcome: 'wait' | 'processed' | 'rejected' | 'failed' | 'skipped'): void;
  referenceFailed(): void;
  reconciliationDivergence(issue: string): void;
  outboxPublishAttempt(result: 'ok' | 'retry' | 'sender-fault'): void;
}
```

**Domain decision.** `settle` is pure. It reads the aggregates, mutates nothing, and returns a decision that the persistence step applies.

```ts
type SettleInput = {
  transaction: WagerTransaction; wallet: Wallet;
  reference: WagerTransaction | null; referenceEntry: WalletLedgerEntry | null;
  existingReversal: WagerTransaction | null;
  ttlReached: boolean;                         // computed by the caller from the database clock
};
type Decision =
  | { kind: 'process'; effect: { direction: 'DEBIT' | 'CREDIT'; amount: Money } | null; details?: ResultDetails }
  | { kind: 'reject'; failureCode: FailureCode; details?: ResultDetails }
  | { kind: 'wait' };
function settle(input: SettleInput): Decision;
```

*   **Persistence step.** `applyOutcome(tx, transaction, wallet, outcome, ctx)` lives in `src/application/wagering/apply-outcome.ts`, where `outcome` is a `Decision` or `{ kind: 'fail' }` from the worker.
    *   It calls `wallet.apply(effect)`, which returns `{ balanceBefore, balanceAfter, version }`, then `WalletLedgerEntry.create`, then the transaction transition.
    *   It builds the events with `buildEvents(outcome, ctx)` and writes everything through `tx`.
    *   It calls `wakeDependents` when a `BET`, `WIN`, or `REFUND` becomes terminal.
*   **Domain delays.** `WagerTransaction.reschedule()` and `OutboxMessage.scheduleRetry()` return a delay in milliseconds, computed with `backoffDelay`. Repositories turn the delay into a time with the database clock.
*   **Use-case commands and results:**

```ts
type SubmitCommand = {
  operation: WagerOperation;                   // the validated core schema
  idempotencyKey: string; channel: 'http' | 'sqs';
  correlationId: string; causationId: string;
  inbox?: { consumerName: string; messageId: string };
};
type SubmitResult = { transaction: TransactionView; replay: boolean };
type MessageOutcome =
  | { kind: 'ack'; reason: 'processed' | 'replay' | 'duplicate' }
  | { kind: 'dlq'; reason: FailureCode | 'UNEXPECTED_ERROR' | 'RETRY_BUDGET_EXHAUSTED' }
  | { kind: 'retry'; errorClass: 'contention' | 'outage' | 'unexpected' };
```

*   **Application errors** (`src/application/errors.ts`):
    *   `WalletNotFound`, `WalletAlreadyExists { walletId }`;
    *   `IdempotencyKeyConflict`, `ExternalTransactionIdConflict`, `MessageIdConflict`;
    *   `IdentityRaceError { constraint: 'idempotency_key' | 'external_transaction_id' | 'inbox' }`;
    *   `ValidationFailed { issues: { path: string; message: string }[] }`;
    *   `ContentionError`, `OutageError`.

**Correlation and causation.**

| Source | `correlationId` | `causationId` |
|---|---|---|
| HTTP | the validated `X-Correlation-Id`, or a new UUIDv7 | the `Idempotency-Key` (wallet creation: the new wallet ID) |
| SQS | the envelope `messageId` | the envelope `messageId` |
| worker | the transaction's stored `correlation_id` | the pending transaction's ID |
| `OPENING` (wallet creation) | the request's correlation ID | the wallet ID |

`correlation_id` is `NOT NULL` on every transaction.

### Schema specification

Names follow `<table>_<columns>_<kind>`: `pkey`, `key` (unique), `fkey`, `check`, `idx`, `trg`. The error classifier maps exactly these unique constraints:

*   `wager_transactions_provider_id_idempotency_key_key` and `wager_transactions_provider_id_external_transaction_id_key` → `IdentityRaceError`;
*   `inbox_pkey` → `IdentityRaceError { constraint: 'inbox' }`;
*   `wallets_player_id_currency_key` → `WalletAlreadyExists`.

| Table | Columns (type, null, default) |
|---|---|
| `wallets` | `id uuid` PK; `player_id uuid NOT NULL`; `currency char(3) NOT NULL`; `balance numeric(14,2) NOT NULL`; `version integer NOT NULL`; `created_at timestamptz(3) NOT NULL DEFAULT now()`; `updated_at timestamptz(3) NOT NULL DEFAULT now()` |
| `wager_transactions` | `id uuid` PK; `provider_id varchar(128)`, `external_transaction_id varchar(128)`, `idempotency_key varchar(255)`, `payload_hash varchar(70)`, `round_id varchar(128)`, `game_id varchar(128)` (all nullable only for `OPENING`); `wallet_id uuid NOT NULL` FK `wallets`; `player_id uuid NOT NULL`; `kind text NOT NULL`; `amount numeric(14,2) NOT NULL`; `currency char(3) NOT NULL`; `reference_external_transaction_id varchar(128) NULL`; `reference_transaction_id uuid NULL`; `status text NOT NULL`; `failure_code text NULL`; `result_details jsonb NULL`; `result_balance_amount numeric(14,2) NULL`; `result_balance_currency char(3) NULL`; `correlation_id varchar(128) NOT NULL`; `attempts integer NOT NULL DEFAULT 0`; `next_reference_attempt_at timestamptz(3) NULL`; `reference_expires_at timestamptz(3) NULL`; `created_at`, `updated_at` as above; `processed_at timestamptz(3) NULL` |
| `wallet_ledger_entries` | `id uuid` PK; `wallet_id uuid NOT NULL`; `transaction_id uuid NOT NULL`; `direction text NOT NULL`; `amount numeric(14,2) NOT NULL`; `currency char(3) NOT NULL`; `balance_before numeric(14,2) NOT NULL`; `balance_after numeric(14,2) NOT NULL`; `wallet_version integer NOT NULL`; `created_at timestamptz(3) NOT NULL DEFAULT now()` |
| `inbox` | `consumer_name varchar(64)`, `message_id varchar(128)` (PK together); `payload_hash varchar(70) NOT NULL`; `idempotency_key varchar(255) NOT NULL`; `transaction_id uuid NOT NULL` (deferred FK); `received_at`, `processed_at timestamptz(3) NOT NULL DEFAULT now()` |
| `outbox` | `id uuid` PK; `aggregate_id uuid NOT NULL`; `wallet_id uuid NOT NULL`; `event_type varchar(64) NOT NULL`; `event_version integer NOT NULL`; `payload jsonb NOT NULL`; `occurred_at timestamptz(3) NOT NULL`; `attempts integer NOT NULL DEFAULT 0`; `next_attempt_at timestamptz(3) NOT NULL DEFAULT now()`; `published_at timestamptz(3) NULL`; `last_error text NULL` |

Trigger rules:

*   **Identity columns.** On `wager_transactions`, the immutable columns are `id`, `provider_id`, `external_transaction_id`, `idempotency_key`, `payload_hash`, `wallet_id`, `player_id`, `round_id`, `game_id`, `kind`, `amount`, `currency`, `reference_external_transaction_id`, `correlation_id`, and `created_at`.
*   **Lifecycle (`wager_transactions_lifecycle_trg`).**
    *   An `UPDATE` of a terminal row is refused, even a no-op.
    *   `PENDING_REFERENCE` → `PENDING_REFERENCE` may change only `attempts`, `next_reference_attempt_at`, and `updated_at`.
    *   The other persisted edges in §4 may change only the result columns, `reference_transaction_id`, `processed_at`, and `updated_at`.
*   **Grants (task 02 setup):**
    *   `GRANT SELECT, INSERT, UPDATE` on the five tables;
    *   `GRANT SELECT` on `mikro_orm_migrations`;
    *   no `DELETE`, no `TRUNCATE`.

### Metrics

| Metric | Type | Labels | Raised by |
|---|---|---|---|
| `wager_transactions_total` | counter | `kind`, `status`, `channel` | `Telemetry.transactionDecided` after commit, in `submit-wager-transaction.ts` and `resolve-pending-references.ts` |
| `wager_processing_duration_seconds` | histogram | `channel` | from use-case entry to commit or replay, in `submit-wager-transaction.ts` |
| `idempotent_replays_total` | counter | `channel` | `submit-wager-transaction.ts` |
| `idempotency_conflicts_total` | counter | `code` | `submit-wager-transaction.ts` |
| `inbox_duplicates_total`, `message_id_conflicts_total` | counter | — | `process-wager-message.ts` |
| `unique_violation_retries_total` | counter | — | `submit-wager-transaction.ts` (identity re-read) |
| `sqs_retries_total` | counter | `error_class` | `sqs-wager-consumer.ts` |
| `sqs_dlq_moves_total` | counter | `reason` | `sqs-dlq-mover.ts` |
| `sqs_dlq_depth` | gauge | — | `database-gauges.ts` (`GetQueueAttributes` at scrape) |
| `reference_attempts_total` | counter | `outcome` | `resolve-pending-references.ts` |
| `reference_failed_total` | counter | — | `resolve-pending-references.ts` |
| `pending_references` | gauge | — | `database-gauges.ts` (count at scrape) |
| `outbox_publish_attempts_total` | counter | `result` | `publish-outbox.ts` |
| `outbox_lag_seconds`, `outbox_pending` | gauge | — | `database-gauges.ts` |
| `outbox_sender_faults_total` | counter | — | `publish-outbox.ts` |
| `wallet_lock_wait_seconds` | histogram | `channel` | `mikro-orm-wallet-repository.ts`, timed around `lock()` |
| `wallet_lock_timeouts_total`, `statement_timeouts_total` | counter | — | `pg-error-classifier.ts` on `55P03` and `57014` |
| `reconciliation_divergences_total` | counter | `issue` | `reconcile-wallet.ts` |
| `bulkhead_rejections_total` | counter | `group` | resilience events, `metrics.ts` |
| `circuit_state` | gauge | `dependency` | resilience events (0 closed, 1 half-open, 2 open) |
| `db_pool_in_use`, `db_pool_waiting` | gauge | — | `database-gauges.ts` |
| `settlement_on_reversed_reference_total` | counter | — | Stretch (task 14) |

Database and queue gauges are computed at scrape time over the gauges share, and only on instances that run the publisher or the worker.

### Test harness

*   **How the app runs in tests.**
    *   `test:integration` and `test:concurrency` run `nest build` once.
    *   `test/support/spawn-app.ts` starts `bun dist/bootstrap/main.js` with `Bun.spawn`, on a port obtained by binding port 0, with the env the test passes.
    *   It waits for `/health/live`, and for `/health/ready` from task 05 on.
    *   It returns the PID, the base URL, and `stop(signal)`.
*   **Infrastructure check and isolation.**
    *   `test/support/infrastructure.ts` is imported by every integration and concurrency spec. In `beforeAll` it:
        1. checks PostgreSQL and MiniStack once, and fails, never skips, if either is missing;
        2. creates the `wagering_test` database on first use, through the setup function, and migrates it;
        3. creates queues with the suffix `-<runId>-<specFile>`, so no two spec files share a queue or a DLQ.
    *   The defaults in `test/support/env.ts` point at the compose services and `wagering_test`.
*   **Outages.** `test/support/tcp-proxy.ts` (`Bun.listen` / `Bun.connect`) sits between each spawned process and PostgreSQL or MiniStack. `cut()` closes current and new connections; `restore()` reopens them. Shared containers are never stopped.
*   **In-process seams.** `test/support/in-process.ts` calls `buildApplication(config, overrides)` against the real `wagering_test` database. Specs that need a failure after a specific write or a selective publisher use it: `atomicity`, `outbox-publisher` (partial batch), and `unit-of-work`.
*   **Spawned faults.** These use `FAULT_INJECTION`:
    *   `crash-after-commit`: the consumer exits between commit and delete;
    *   `crash-after-send`: the publisher exits between send and commit;
    *   `unexpected-on-wallet:<id>`: an unexpected error for that wallet only.
*   **Contention in tests.** The test holds the wallet row lock from its own connection (`BEGIN; SELECT … FOR UPDATE`). It shortens `DB_LOCK_TIMEOUT_MS`, `SQS_BACKOFF_*`, and `SQS_VISIBILITY_TIMEOUT_SECONDS`, and shrinks `HTTP_BULKHEAD_*`.
*   **Fakes** for application specs live in `test/support/fakes/` (in-memory repositories, unit of work, clock, ID generator, publisher, telemetry).
*   **Helpers.**
    *   `wait-for.ts`: poll a condition with an explicit timeout, never a bare sleep;
    *   `http-client.ts`: retry `503` with the same key;
    *   `factories.ts`: unique IDs per test;
    *   `reconcile.ts`: `expectReconciled(walletIds)`;
    *   `sqs.ts`: send, read attributes, read the DLQ;
    *   `event-reader.ts`: read events and remove duplicates by `eventId`.

### Implementation list by board task

Unit tests sit next to their source as `*.spec.ts` and run with `bun test ./src/`.

#### Task 01 — Define architecture and contracts

| File | Action | What and why |
|---|---|---|
| `ARCHITECTURE.md` | write (the file exists and is empty) | First version from this design: current design by rubric area, failure-code catalog, interpretations of the challenge, risks, non-goals, and the decision log as an appendix. Once written it is canonical and this design is frozen; later tasks update the section they touch and append to its log. |
| Board cards 02, 09, 10, and a new card 14 | edit | Card 02 gains the platform spike checklist. Card 09 gets one application DLQ path, the per-class budgets, and per-group ordering. Card 10 gets the single-transaction `SKIP LOCKED` cycle with no dead-letter state. Card 14 lists the Stretch items. |

Done when: `ARCHITECTURE.md` contains the sections above, and the four cards contain the edits above.

#### Task 02 — Set up a reproducible environment and CI

| File | Action | What and why |
|---|---|---|
| `package.json` | change | **Dependencies:** add `@nestjs/terminus`, `@nestjs/resilience`, `@mikro-orm/core`, `@mikro-orm/postgresql`, `@mikro-orm/migrations`, `@mikro-orm/nestjs`, `zod`, `@aws-sdk/client-sqs`, `prom-client`, at the versions in Settled implementation choices. Remove `supertest`, `@types/supertest`, `@nestjs/mau`, and `source-map-support`. Keep `@nestjs/testing` and the existing `^12` ranges. **Scripts:** see the scripts table below. |
| `bun.lock` | change | Lockfile for the dependencies above. |
| `tsconfig.json` | change | Add `migrations/**/*.ts` and `scripts/**/*.ts` to `include` (`test/` is already there). |
| `tsconfig.build.json`, `nest-cli.json`, `bunfig.toml` | keep | `nest build` compiles `src/` to `dist/`. `nest start` is no longer used, so `entryFile` does not matter. `bunfig.toml` already ignores `.settings`, the git-ignored folder for working notes. |
| `.oxlintrc.json` | change | The JSON in Dependency rule. |
| `.env.example` | create | Every variable in the configuration table with its default. |
| `Dockerfile` | create | Stages on `oven/bun:1.4.4`. Install with the lockfile, then `nest build`. The final stage runs `bun install --production` and copies `dist/`, `src/`, `migrations/`, and `scripts/`; `src/` is needed because the setup script runs from source. The command is `CMD ["bun", "dist/bootstrap/main.js"]`, in exec form. |
| `.dockerignore` | create | Excludes `node_modules`, `dist`, `coverage`, `.git`, `.settings`. |
| `docker-compose.yml` | create | **`postgres:17.11`:** `POSTGRES_USER=wagering_owner`, `POSTGRES_PASSWORD=wagering_owner`, `POSTGRES_DB=wagering`, `command: postgres -c max_connections=200`, health check, port 5432. **`ministackorg/ministack:1.5.39`:** port 4566, health check. **`setup`:** one-shot, from the app image, `command: ["bun", "scripts/setup.ts"]`. **`app-1`, `app-2`, `app-3`:** profile `app`, ports 3001–3003, `init: true`, `stop_grace_period: 30s`, each depending on `setup` completing. |
| `scripts/migrate.ts` | create | `migrate(direction, ownerUrl)` using the MikroORM `Migrator` with the classes from `migrations/index.ts`. The CLI form is `bun scripts/migrate.ts up\|down`. |
| `scripts/setup.ts` | create | Exports `setup({ database?, queueSuffix? })` and runs it when executed directly. Idempotent, in order: (1) create the database if a name is given and it is missing; (2) migrate up as the owner; (3) create the app role from `DATABASE_URL` if missing, and apply the grants in Schema specification; (4) create the DLQ and read its ARN; (5) create the input queue with `RedrivePolicy` (`maxReceiveCount` 50) and the configured visibility; (6) create the events queue. `QueueAlreadyExists` counts as success. |
| `migrations/index.ts` | create | The ordered migration list and `LATEST_MIGRATION`; filled in task 04. |
| `src/bootstrap/main.ts`, `src/bootstrap/app.module.ts` | create | Minimal Nest application on Express, with `enableShutdownHooks()` and `GET /health/live`. Extended in later tasks. |
| `src/infrastructure/config/app-config.ts` | create | Zod schema for the configuration table; `loadConfig(env)` returns a frozen `AppConfig` and refuses `FAULT_INJECTION` unless `NODE_ENV=test`. |
| `src/infrastructure/config/app-config.spec.ts` | create | Defaults, boolean and number parsing, fault-injection refusal. |
| `src/infrastructure/persistence/mikro-orm.config.ts` | create | `createOrmConfig(config, entities)`: `PostgreSqlDriver`, the entity list as a parameter (empty until task 04), `allowGlobalContext: false`, pool max and acquire timeout from config, `statement_timeout` on connect. |
| `.github/workflows/ci.yml` | create | Job 1: `bun install --frozen-lockfile`, `bun run check`, `bun run build`. |
| `test/support/env.ts`, `test/support/infrastructure.ts`, `test/support/spawn-app.ts`, `test/support/wait-for.ts` | create | See Test harness. `spawn-app` waits for `/health/live` until task 05. |
| `test/integration/platform.spec.ts` | create | The platform spike, as a regression test. Every row of the checklist in Risks & Mitigations has a pass criterion. MikroORM and Nest checks use throwaway inline entities and a throwaway Nest module. |
| `test/integration/lint-rules.spec.ts` | create | Writes a temporary file that breaks each layer rule, runs `oxlint`, and expects one report per file. |
| `README.md` | rewrite | Currently a short project README; keep its repository and board links. Add prerequisites (Docker, Bun), `bun install`, `docker compose up -d postgres ministack setup`, and every script. Completed in task 13. |
| `src/main.ts`, `src/app.module.ts`, `src/app.controller.ts`, `src/app.controller.spec.ts`, `src/app.service.ts`, `test/app.e2e.spec.ts` | delete | Starter code, replaced by `src/bootstrap/`. |
| `AGENTS.md` | change | The NestJS Observe paragraph points to `src/bootstrap/app.module.ts`. |

Scripts after task 02:

| Script | Command |
|---|---|
| `build` | `nest build` (kept) |
| `start:dev` | `bun --watch src/bootstrap/main.ts` |
| `start:prod` | `bun dist/bootstrap/main.js` |
| `setup` | `bun scripts/setup.ts` |
| `migrate:up` / `migrate:down` | `bun scripts/migrate.ts up` / `bun scripts/migrate.ts down` |
| `typecheck` | `tsc --noEmit` (kept) |
| `lint` | `oxlint --deny-warnings src/ test/ migrations/ scripts/` |
| `format` | `oxfmt "src/**/*.ts" "test/**/*.ts" "migrations/**/*.ts" "scripts/**/*.ts"` |
| `format:check` | `oxfmt --check "src/**/*.ts" "test/**/*.ts" "migrations/**/*.ts" "scripts/**/*.ts"` |
| `test`, `test:watch`, `test:cov`, `test:debug` | kept (unit tests under `./src/`) |
| `test:integration` | `nest build && bun test --timeout 60000 ./test/integration/` |
| `test:concurrency` | `nest build && bun test --timeout 180000 ./test/concurrency/` |
| `test:all` | `bun run test && bun run test:integration && bun run test:concurrency` |
| `check` | `bun run typecheck && bun run lint && bun run format:check && bun run test` |
| removed | `start`, `start:debug`, `deploy`, `test:e2e` |

Done when:

*   on a fresh clone, `bun install`, `docker compose build`, and `docker compose up -d postgres ministack setup` succeed, with setup running from the built image;
*   `bun run check` passes, and `platform.spec` and `lint-rules.spec` pass;
*   CI job 1 passes.

#### Task 03 — Implement the financial domain and unit tests

| File | Action | What and why |
|---|---|---|
| `src/domain/shared/domain-error.ts` | create | `DomainError` with a stable `code`; subclasses for invalid money, currency mismatch, invalid transition, invariant violation. |
| `src/domain/shared/backoff.ts` | create | `backoffDelay(attempt, { baseMs, capMs }, random)`: `min(base · 2^(attempt − 1), cap)`, jitter uniform in `[delay/2, delay]`. |
| `src/domain/shared/backoff.spec.ts` | create | Attempt 1 gives `[base/2, base]`; the cap holds at attempt 20; a fixed random source gives a fixed value. |
| `src/domain/money/money.ts` | create | `Money` (§3): `from`, `ofMinor`, `add`, `subtract`, `negate`, `compare`, `isZero`, `toProps()`, `MONEY_CEILING`. |
| `src/domain/money/money.spec.ts` | create | Each rejected form in §3 throws; `0.10 + 0.20 = 0.30`; cross-currency arithmetic throws; `999999999999.99` parses; round trip through `toProps`. |
| `src/domain/failure-code.ts` | create | The persisted failure codes from §6. |
| `src/domain/wallet/wallet.ts` | create | `Wallet.open`, `rehydrate`, `apply(effect)` returning `{ balanceBefore, balanceAfter, version }` and throwing outside `[0, ceiling]`, `belongsTo(playerId)`. |
| `src/domain/wallet/wallet.spec.ts` | create | A debit below zero throws; a credit above the ceiling throws; `version` increases by one per applied effect and not otherwise; a currency mismatch throws. |
| `src/domain/transaction/transaction-kind.ts`, `transaction-status.ts` | create | Kinds, the effect table, allowed references (§5); statuses and persisted edges (§4). |
| `src/domain/transaction/wager-transaction.ts` | create | `create`, `open`, `rehydrate`; transitions `markProcessed`, `markRejected`, `waitForReference`, `reschedule()` (returns a delay), `markFailed`. |
| `src/domain/transaction/wager-transaction.spec.ts` | create | Each allowed edge succeeds and each forbidden edge throws; `create` rejects `OPENING`; `open` has no provider fields. |
| `src/domain/ledger/wallet-ledger-entry.ts` (+ `.spec.ts`) | create | `create` checks `balanceBefore ± amount = balanceAfter` and `amount > 0`. The spec covers one valid entry per direction and one mismatch per direction. |
| `src/domain/settlement/settle.ts` | create | The pure function in Port contracts, running D2–D11 and the TTL variants. |
| `src/domain/settlement/settle.spec.ts` | create | One case per check and kind, in order. `REFUND` before `WIN` and `WIN` before `REFUND` both give `process` with `details.referenceReversedBy`. A `ROLLBACK` of a `REFUND` debits. `LOSS` gives `process` with no effect. `ttlReached` with an absent reference gives `REFERENCE_NOT_FOUND`, and with a pending one gives `REFERENCE_NOT_READY`. |
| `src/domain/messaging/inbox-message.ts`, `outbox-message.ts` (+ `outbox-message.spec.ts`) | create | `InboxMessage.receive`, `matches(payloadHash, idempotencyKey)`; `OutboxMessage.enqueue(event)`, `markPublished()`, `scheduleRetry()` (returns a delay; cap 5 min). The spec checks the delay sequence and that a published message refuses `scheduleRetry`. |
| `src/domain/events/integration-event.ts`, `wager-events.ts` (+ `wager-events.spec.ts`) | create | The envelope and the five events with the `data` in §13. The spec checks `toJSON()` field names and money as strings. |
| `src/domain/reconciliation/reconciliation-report.ts` (+ `.spec.ts`) | create | Builds the report from the aggregate numbers; Core ships `BALANCE_MISMATCH`. The spec covers a consistent wallet, a wallet opened at zero, and a mismatch with its signed difference. |

Done when: `bun test ./src/` passes with every domain item of challenge §13 (Money, Wallet, kind rules, currency conflict), and `bun run lint` reports no layer violation.

#### Task 04 — Create the schema, migrations, and transactional persistence

| File | Action | What and why |
|---|---|---|
| `migrations/0001-wallets.ts` … `migrations/0006-worker-indexes.ts` | create | `0001-wallets`, `0002-wager-transactions`, `0003-wallet-ledger-entries`, `0004-inbox-outbox` (deferred inbox FK; outbox write-once trigger), `0005-commit-consistency` (tip, chain, transaction, and direction checks), `0006-worker-indexes`. Names and columns as in Schema specification. |
| `migrations/index.ts` | change | The six classes and `LATEST_MIGRATION = 'Migration0006WorkerIndexes'`. |
| `src/infrastructure/persistence/records/wallet.record.ts`, `wager-transaction.record.ts`, `wallet-ledger-entry.record.ts`, `inbox.record.ts`, `outbox.record.ts` | create | `defineEntity` records; money as `decimal` with a string runtime type; `concurrencyCheck` on `wager_transactions.status`. |
| `src/infrastructure/persistence/mappers/wallet.mapper.ts`, `wager-transaction.mapper.ts`, `wallet-ledger-entry.mapper.ts`, `inbox.mapper.ts`, `outbox.mapper.ts` | create | `toDomain` calls `rehydrate`; `applyTo(record, aggregate)`. |
| `src/application/ports/unit-of-work.ts`, `repositories.ts`, `clock.ts`, `id-generator.ts` | create | As in Port contracts. |
| `src/application/errors.ts` | create | As in Port contracts. |
| `src/infrastructure/persistence/mikro-orm-unit-of-work.ts` | create | `em.transactional` on a fork; `set_config` for `lock_timeout` and `transaction_timeout` (local); one `flush`; error classification on the way out. It receives the contention retry as an injected `(fn) => Promise` (identity until task 05). |
| `src/infrastructure/persistence/pg-error-classifier.ts` (+ `.spec.ts`) | create | SQLSTATE and constraint name → class, as in §10 and Schema specification. One case per SQLSTATE family and per mapped constraint. |
| `src/infrastructure/persistence/repositories/mikro-orm-wallet-repository.ts`, `mikro-orm-transaction-repository.ts`, `mikro-orm-ledger-repository.ts`, `mikro-orm-inbox-repository.ts`, `mikro-orm-outbox-repository.ts`, `sql-reconciliation-reader.ts` | create | Port implementations. Raw SQL only for the inbox insert, the outbox claim, the wake-up, `reschedule`, `pushBack`, the due selection, the re-check, the pending-row times, and the reconciliation aggregates. |
| `src/infrastructure/clock/system-clock.ts`, `src/infrastructure/ids/uuid-v7-generator.ts` | create | `Bun.randomUUIDv7()`. |
| `src/bootstrap/container.ts` | create | `buildApplication(config, overrides?)` with persistence adapters; extended in later tasks. |
| `test/support/database.ts`, `test/support/in-process.ts` | create | Owner and app connections for direct SQL; the in-process application. |
| `test/integration/migrations.spec.ts` | create | Up, down, up on a scratch database; afterward `LATEST_MIGRATION` is the last row of `mikro_orm_migrations`. |
| `test/integration/schema-constraints.spec.ts` | create | Each `CHECK`, unique index, FK, and trigger violated as `wagering_app` is rejected with its named constraint or trigger. `DELETE` and `TRUNCATE` are refused. A no-op update of a terminal row is refused. Clearing an outbox `published_at` or rewriting its payload is refused. |
| `test/integration/commit-consistency.spec.ts` | create | Each case fails at `COMMIT` with the trigger's name: a ledger-only insert, a wallet-only update, a wrong direction, an entry for a non-`PROCESSED` transaction, a forged `balance_before` with a matching wallet update, and a version gap. |
| `test/integration/mappers.spec.ts` | create | Each aggregate equals itself after save and load. |
| `test/integration/unit-of-work.spec.ts` | create | `current_setting` returns the configured timeouts. A failure injected in-process after the third write leaves no row. A forced `transaction_timeout` raises `ContentionError` and the next call gets a new connection. |

Done when: these five integration specs and the classifier spec pass.

#### Task 05 — Deliver wallets, ledger queries, reconciliation, and the operational base

| File | Action | What and why |
|---|---|---|
| `src/application/ports/queries.ts`, `telemetry.ts`, `request-context.ts`, `provider-identity.ts` | create | As in Port contracts. |
| `src/application/wallets/open-wallet.ts` | create | `Wallet.open`, plus for a positive balance `WagerTransaction.open` and its `CREDIT` entry through `applyOutcome`, in one unit of work. A conflict raises `WalletAlreadyExists` with the existing ID. |
| `src/application/wagering/apply-outcome.ts`, `build-events.ts` | create | The persistence step and event construction (Port contracts). |
| `src/application/wallets/reconcile-wallet.ts` | create | Runs `ReconciliationReader.aggregate` in `read-only-snapshot` mode; builds the report; raises `reconciliationDivergence`. |
| `src/infrastructure/persistence/sql-query-port.ts` | create | `QueryPort` with short read-only transactions. |
| `src/contracts/primitives.ts` (+ `primitives.spec.ts`), `src/contracts/wallet.schemas.ts` (+ `wallet.schemas.spec.ts`) | create | ID formats, lowercase UUID, contract amount, currency, idempotency key; the `POST /wallets` body, path params, ledger query (`limit` 1–200, else 400) and cursor. Specs: one accept and one reject per rule. |
| `src/interface/http/validation.ts` | create | Global `StandardSchemaValidationPipe` with an `exceptionFactory` that throws `ValidationFailed` (`issues: [{ path, message }]`). |
| `src/interface/http/error.filter.ts` | create | Maps application and domain errors to §6 and §7; `ValidationFailed` → `400 VALIDATION_FAILED` with `details.issues`; every `503` carries `Retry-After: 1`. |
| `src/interface/http/request-context.middleware.ts` | create | `X-Request-Id`, validated `X-Correlation-Id`, opens the context through the port. |
| `src/interface/http/wallets.controller.ts`, `presenters.ts` | create | The four wallet routes; the ledger page has `nextCursor: null` on the last page. |
| `src/infrastructure/observability/request-context.ts` | create | `AsyncLocalStorage` implementation of the port. |
| `src/infrastructure/observability/json-logger.ts` | create | `ConsoleLogger` with `json: true`, merging the context fields. |
| `src/infrastructure/observability/metrics.ts`, `metrics.controller.ts` | create | One `prom-client` registry implementing `Telemetry`, with every metric in the metric table that the code of tasks 05–08 raises; `GET /metrics`. |
| `src/infrastructure/observability/health.controller.ts`, `indicators.ts` | create | `/health/live`; `/health/ready` with PostgreSQL `SELECT 1` and the `LATEST_MIGRATION` check (SQS is added in task 09). |
| `src/infrastructure/resilience/policies.ts` | create | Named policies: the HTTP contention retry, the bulkheads (HTTP, reconciliation, readiness, metrics), and the `postgres` circuit with `recordIf` = Outage. |
| `src/infrastructure/auth/trust-all-provider-identity.ts` | create | Accepts any well-formed `providerId`; logs one warning at startup. |
| `src/bootstrap/bulkhead.interceptor.ts` | create | Global interceptor that applies the bulkhead for each route group. |
| `src/bootstrap/container.ts`, `app.module.ts`, `main.ts` | change | Wire the above; `MikroOrmModule.forRoot(createOrmConfig(...), { registerRequestContext: false })`; the role flags for the controllers. |
| `src/bootstrap/persistence.module.ts`, `http.module.ts`, `observability.module.ts` | create | Nest modules exposing the container's results. |
| `test/support/spawn-app.ts` | change | Waits for `/health/ready`. |
| `test/support/http-client.ts`, `factories.ts`, `reconcile.ts`, `fakes/*.ts` | create | See Test harness. The fakes are `in-memory-unit-of-work.ts`, `in-memory-repositories.ts`, `fixed-clock.ts`, `sequential-ids.ts`, `recording-publisher.ts`, `recording-telemetry.ts`. |
| `test/integration/wallets-http.spec.ts` | create | Creating with `0.00` returns 201 with `version` 1 and no ledger entry. Creating with `100.00` returns one `CREDIT`. A duplicate `(player, currency)` returns 409 with `details.walletId`. Unknown IDs return 404. Paging 120 entries with `limit` 50 returns 50, 50, 20, then `nextCursor: null`. `limit=500` and a garbage cursor return 400. |
| `test/integration/reconciliation.spec.ts` | create | A consistent wallet returns `consistent: true` and `checkedEntries`. A wallet opened at zero is consistent with 0 entries. A balance corrupted as the owner (triggers disabled) returns `BALANCE_MISMATCH` with the signed difference and increments the metric. |
| `test/integration/operational.spec.ts` | create | The startup warning of `TrustAllProviderIdentity` appears once. An invalid `X-Correlation-Id` is replaced, and a valid one is echoed in logs. `/health/ready` reports the migration check. |

Done when: `wallets-http`, `reconciliation`, and `operational` pass.

#### Task 06 — Implement basic processing and persistent idempotency

| File | Action | What and why |
|---|---|---|
| `src/application/idempotency/payload-hash.ts` (+ `.spec.ts`) | create | Canonical JSON, SHA-256, `v1:<hex>`; hashes are compared as strings. The spec's first commit pins one literal vector computed by the implementation. Reordering keys does not change the hash, an absent optional field is not hashed, and an explicit `null` is rejected. |
| `src/application/wagering/submit-wager-transaction.ts` | create | The §10 flow with the §8 decision table. It generates the transaction ID before the unit of work. On SQS it inserts the inbox row first; a replay found under the lock rolls back and records the inbox row in the short replay transaction. It re-reads once on an `IdentityRaceError`. Contention retries come from the unit of work when `retryContention` is true. |
| `src/application/wagering/submit-wager-transaction.spec.ts` | create | With fakes: each row of the §8 table; status from stored state; a pending replay takes no lock; the events per outcome; an identity race replays. |
| `src/application/wagering/wager-queries.ts` | create | Transaction by ID and by external ID through `QueryPort`. |
| `src/contracts/wager-operation.schema.ts` (+ `.spec.ts`) | create | The core operation schema (§7) with V1–V7, and the SQS `data` extension with `idempotencyKey`. The spec has one accept and one reject case for each of V1–V7, including an unknown field, an explicit `null`, `OPENING`, a `LOSS` of `0.00`, and a self-reference. |
| `src/interface/http/wagering-transactions.controller.ts`, `transaction-presenter.ts` | create | `POST /wagering/transactions` with `@Headers('idempotency-key', { schema })`; the two `GET` routes; status from stored state (200, 202 with `Location`, 422). |
| `src/bootstrap/container.ts`, `http.module.ts` | change | Wire the use case and controller. |
| `test/integration/wagering-http.spec.ts` | create | Each kind's happy path with its balance. Each row of the §8 table. A missing `Idempotency-Key` gives 400. An unknown wallet gives 404 with no row stored. Each 422 code reachable without references. With `HTTP_BULKHEAD_SIZE=1` and `HTTP_BULKHEAD_QUEUE=0` and the wallet lock held by the test, a second request gets 503 with `Retry-After: 1`. |
| `test/integration/atomicity.spec.ts` | create | In-process: a failure after each write of the persistence step (transaction, wallet, ledger, outbox) leaves zero rows in all five tables for that operation. |

Done when: `wagering-http`, `atomicity`, and the new unit specs pass (CUJ 1 over HTTP).

#### Task 07 — Verify idempotency and financial concurrency (HTTP)

| File | Action | What and why |
|---|---|---|
| `test/concurrency/duplicate-bet.spec.ts` | create | Scenario 1: one bet sent 50 times over 3 processes gives one debit; all 50 responses carry the same `transactionId` and balance. |
| `test/concurrency/balance-contention.spec.ts` | create | Scenario 2 (challenge §8): 3 processes; two `80.00` bets on a `100.00` wallet to two different processes give one `PROCESSED`, one `INSUFFICIENT_FUNDS`, `20.00`, one debit. |
| `test/concurrency/parallel-wallets.spec.ts` | create | Scenario 3: 30 wallets × 20 bets over 3 processes; every wallet reconciles. SQS traffic is added in task 09. |
| `test/concurrency/ceiling-credits.spec.ts` | create | 20 concurrent `WIN`s of `100.00` on a wallet at `999,999,999,000.00`: the balance never exceeds the ceiling, and the extra credits get `BALANCE_LIMIT_EXCEEDED`. |
| `test/concurrency/hot-wallet.spec.ts` | create | 3 processes; 200 concurrent bets on one wallet while 10 other wallets receive one bet each. The other wallets' bets complete. The `postgres` circuit stays closed (`circuit_state` 0). Excess burst requests get 503. SQS and publisher assertions are added in tasks 09 and 10. |

Every concurrency spec asserts distinct PIDs (scenario 4) and ends with `expectReconciled`.

Done when: the five specs pass in 20 consecutive local runs.

#### Task 08 — Implement reversals and out-of-order references

| File | Action | What and why |
|---|---|---|
| `src/application/wagering/resolve-pending-references.ts` | create | One cycle (§11): `selectDue` from a random offset, wallet `lock('skip-locked')` (or `'wait'` when `recheck` says the TTL is reached), `pushBack` on a busy wallet, `recheck`, `settle`, then `applyOutcome` or `reschedule`. An unexpected error at the TTL gives `{ kind: 'fail' }` in a new unit of work. |
| `src/application/wagering/resolve-pending-references.spec.ts` | create | With fakes: the reschedule delay grows; a busy wallet pushes back without counting an attempt; the TTL outcomes; the fail path writes `FAILED` through `applyOutcome`. |
| `src/infrastructure/polling/polling-loop.ts` (+ `.spec.ts`) | create | Shared polling loop: run a cycle; wait the idle poll when a cycle found nothing; skip cycles while a needed circuit is open (half-open runs the normal cycle); on shutdown stop and await the cycle in progress. The spec uses a fake clock and covers each of these. |
| `src/bootstrap/workers.module.ts`, `container.ts`, `app.module.ts` | create, change | Start the worker loop when `REFERENCE_WORKER_ENABLED`. |
| `test/integration/reversals.spec.ts` | create | A successful `REFUND` of a `BET`, then a `ROLLBACK` of the same `BET` gets `REFERENCE_ALREADY_REVERSED`. A `ROLLBACK` of a `WIN` debits. A `ROLLBACK` of a `REFUND` debits. `REVERSAL_INSUFFICIENT_FUNDS`. A `WIN` against a reversed `BET`, in both arrival orders, is `PROCESSED` with `details.referenceReversedBy`. |
| `test/integration/pending-references.spec.ts` | create | A `REFUND` before its `BET` returns 202; after the `BET`, it is `PROCESSED` within 2 s through the wake-up. With `REFERENCE_TTL_SECONDS=3`: an absent reference gives `REFERENCE_NOT_FOUND`, and a reference still pending gives `REFERENCE_NOT_READY`. Two workers on an absent reference increment `attempts` once per backoff window. A pending row on a locked wallet does not stop 5 other due rows from being processed. |
| `test/concurrency/out-of-order.spec.ts` | create | Scenario 7 over HTTP on 3 processes: 20 reversals sent before their bets all end `PROCESSED`, with one reversal each. SQS is added in task 09. |

Done when: `reversals`, `pending-references`, `out-of-order`, and the new unit specs pass (CUJ 3).

#### Task 09 — Add SQS consumption with inbox, retries, and DLQ

| File | Action | What and why |
|---|---|---|
| `src/application/messaging/process-wager-message.ts` | create | Inbox-first lookup, the short replay transaction, the call into `SubmitWagerTransaction`, and the zero-row inbox insert; returns a `MessageOutcome`. |
| `src/contracts/sqs-envelope.schema.ts` (+ `.spec.ts`) | create | Envelope `{ messageId, type: "WagerTransactionRequested", occurredAt, data }`. The spec covers an unknown field at each level, a wrong `type`, and a missing `data.idempotencyKey`. |
| `src/infrastructure/messaging/sqs-client.ts` | create | One `SQSClient` from `AppConfig`, behind the `sqs` circuit. |
| `src/infrastructure/messaging/sqs-retry-policy.ts` (+ `.spec.ts`) | create | `(errorClass, receiveCount)` → ack, DLQ, or backoff (tuning table). The spec covers every budget row and the backoff values for receive counts 1 to 10. |
| `src/infrastructure/messaging/sqs-wager-consumer.ts` | create | The §12 adapter: receive up to the free group slots; group by `MessageGroupId`; serial within a group; extend visibility before each waiting message; release siblings only on backoff; ack after commit; skip while a circuit is open; drain on `SIGTERM`. |
| `src/infrastructure/messaging/sqs-dlq-mover.ts` | create | `moveToDlq(message, reason)`: send with the original group, deduplication ID, and the four attributes; then delete. |
| `src/infrastructure/fault-injection.ts` | create | Every fault point: `crash-after-commit`, `crash-after-send` (used in task 10), `unexpected-on-wallet:<id>`. |
| `src/infrastructure/observability/indicators.ts`, `metrics.ts` | change | Readiness adds SQS `GetQueueAttributes`; the SQS metrics. |
| `src/bootstrap/messaging.module.ts`, `container.ts`, `app.module.ts` | create, change | Start the consumer when `SQS_CONSUMER_ENABLED`. |
| `test/support/sqs.ts` | create | Send envelopes, read attributes including in-flight counts, read the DLQ. |
| `test/integration/inbox-redelivery.spec.ts` | create | A duplicate delivery gives one effect and `inbox_duplicates_total` + 1. The same `messageId` with another payload goes to the DLQ as `MESSAGE_ID_CONFLICT`. Two concurrent deliveries of one `messageId`: same payload gives one effect and one inbox row; different payload gives one effect and one DLQ message. HTTP then SQS with the same key is a replay. The race where HTTP commits between the unlocked lookup and the lock gives one transaction and one inbox row pointing at it. |
| `test/integration/sqs-dlq.spec.ts` | create | Validation and identity errors go to the DLQ on the first receive with `failureReason`. `unexpected-on-wallet` goes to the DLQ on the 3rd receive. With the wallet lock held and short backoff, contention goes to the DLQ on the 10th receive as `RETRY_BUDGET_EXHAUSTED`. |
| `test/integration/sqs-ordering.spec.ts` | create | `WIN 50` then `BET 120` in one group on a `100.00` wallet are applied in that order (both `PROCESSED`). A backed-off first message releases its two siblings, and all three apply in order. After a DLQ move, the next sibling is processed without a release. |
| `test/concurrency/crash-after-commit.spec.ts` | create | Scenario 5: process A (with `crash-after-commit`, 5 s visibility) receives a bet and exits after commit. Then B and C start. Within 15 s one survivor shows `inbox_duplicates_total` + 1 on its own `/metrics`. The queue, in-flight count, and DLQ are 0, with one entry and one inbox row. |
| `test/concurrency/parallel-wallets.spec.ts`, `out-of-order.spec.ts`, `hot-wallet.spec.ts` | change | Half of the traffic goes through SQS; `hot-wallet` asserts that the other wallets' SQS messages complete. |

Done when: these specs pass (CUJ 4).

#### Task 10 — Implement concurrent outbox publishing

| File | Action | What and why |
|---|---|---|
| `src/application/ports/event-publisher.ts` | create | As in Port contracts. |
| `src/application/messaging/publish-outbox.ts` (+ `.spec.ts`) | create | One cycle (§13). The spec with fakes covers a partial result (2 of 10 fail: 8 published, 2 rescheduled) and a whole-call failure (no attempts counted). |
| `src/infrastructure/messaging/sqs-event-publisher.ts` | create | `SendMessageBatch` with group `wallet_id`, deduplication `eventId`, `maxAttempts: 1`, 5 s abort, behind the `sqs` circuit; calls the `crash-after-send` fault point. |
| `src/bootstrap/workers.module.ts`, `container.ts` | change | Start the publisher loop when `OUTBOX_PUBLISHER_ENABLED`. |
| `test/support/event-reader.ts`, `test/support/fakes/selective-failing-publisher.ts` | create | See Test harness. |
| `test/integration/outbox-publisher.spec.ts` | create | Each outcome emits the events in §13 and a replay emits none. In-process: entries 3 and 7 of a 10-row batch fail, the other 8 are published, and the 2 are published on a later cycle. Two in-process publishers on 100 rows never send the same row in one cycle. |
| `test/concurrency/concurrent-publishers.spec.ts` | create | Scenario 6: 2 publishers and 300 events, plus a third process with `crash-after-send`. All 300 `eventId`s arrive; republished ones carry the same `eventId`. |
| `test/concurrency/hot-wallet.spec.ts` | change | Asserts that the publisher keeps publishing during the burst. |

Done when: `outbox-publisher`, `concurrent-publishers`, and `publish-outbox.spec` pass.

#### Task 11 — Complete observability and health checks

| File | Action | What and why |
|---|---|---|
| `src/infrastructure/observability/metrics.ts`, `database-gauges.ts` | change, create | The remaining metrics in the metric table; gauges at scrape time. |
| `src/infrastructure/observability/health.controller.ts` | change | 503 while draining; the body names the failing dependency. |
| `test/support/tcp-proxy.ts` | create | See Test harness. |
| `test/integration/observability.spec.ts` | create | Each required metric changes after the operation that triggers it. Logs carry the context IDs and match no amount pattern. Cutting the PostgreSQL proxy makes readiness 503 within 2 s, naming `postgres`. |
| `test/integration/shutdown.spec.ts` | create | `SIGTERM` while 20 messages are in flight: the messages in progress finish, unstarted ones are released, and all 20 end processed, with no DLQ entries. |
| `test/concurrency/sqs-outage.spec.ts` | create | CUJ 6 with a 60 s outage through the proxy. The `sqs` circuit opens. HTTP keeps committing 100 bets. No receive budget is used. After `restore()`, all events are published with their original `eventId`s. |

Done when: `observability`, `shutdown`, and `sqs-outage` pass (CUJ 5 and CUJ 6).

#### Task 12 — Verify recovery across multiple instances

| File | Action | What and why |
|---|---|---|
| `test/concurrency/restart-recovery.spec.ts` | create | Scenario 8: 3 processes under 500 mixed operations get `SIGKILL`; 3 new processes start. Within 60 s: no pending reference rows, no unpublished outbox rows, an empty queue and in-flight count, and every wallet reconciles. |
| `test/concurrency/reconcile-during-writes.spec.ts` | create | 20 reconciliations during 300 concurrent writes all return `consistent: true`. |

Done when: `bun run test:all` passes three times in a row locally.

#### Task 13 — Finalize documentation and the delivery demonstration

| File | Action | What and why |
|---|---|---|
| `README.md` | complete | Setup, every command, each test layer, `docker compose --profile app up`, and a demo with `curl` commands. |
| `ARCHITECTURE.md` | complete | The test matrix and requirement-to-test table below, test evidence, risks and limitations, the DLQ redrive procedure, and the decision log. |

Done when: following `README.md` on a fresh clone runs every command in the Commands table successfully, and `ARCHITECTURE.md` contains each item above.

#### Task 14 — Stretch (only after tasks 01–13 pass)

| File | Action | What and why |
|---|---|---|
| `.github/workflows/ci.yml` | change | Job 2: PostgreSQL 17 and MiniStack as service containers, `bun scripts/setup.ts`, then `test:integration` and `test:concurrency`. |
| `src/domain/reconciliation/reconciliation-report.ts`, `src/application/wallets/reconcile-wallet.ts`, `src/infrastructure/persistence/repositories/sql-reconciliation-reader.ts`, `test/integration/reconciliation.spec.ts` | change | `VERSION_MISMATCH`, `CHAIN_GAP`, and `CHAIN_BREAK` (§14), each with a corruption test. |
| `src/application/ports/telemetry.ts`, `src/application/wagering/apply-outcome.ts`, `src/infrastructure/observability/metrics.ts` | change | `settlement_on_reversed_reference_total`. |
| `scripts/demo.ts` | create | Runs against `app-1..3`: contention, replay, out-of-order reversal, crash recovery, reconciliation. |
| `scripts/redrive-dlq.ts` | create | Moves DLQ messages whose `failureReason` is `RETRY_BUDGET_EXHAUSTED`, or `UNEXPECTED_ERROR` after a fix, back to the input queue. |

Done when: CI job 2 passes the full suite three times in a row, and the changed reconciliation specs pass.

Load testing (`bun run test:load`) is outside this plan; if attempted, it starts after task 14.

### Verification Plan

#### Goals to tests

| Goal | Proven by |
|---|---|
| G1 No money created or lost | `money.spec`, `wallet.spec`, `wallet-ledger-entry.spec`, `schema-constraints`, `commit-consistency`, `expectReconciled` at the end of every financial test |
| G2 Correct under contention | `balance-contention`, `parallel-wallets`, `ceiling-credits`, `hot-wallet` |
| G3 Exactly-once effect | `duplicate-bet`, `wagering-http`, `payload-hash.spec`, `inbox-redelivery`, `sqs-ordering` |
| G4 Out-of-order converges | `settle.spec`, `pending-references`, `out-of-order`, `reversals` |
| G5 Crash and outage recovery | `crash-after-commit`, `concurrent-publishers`, `restart-recovery`, `sqs-outage`, `shutdown` |
| G6 No committed event lost | `outbox-publisher`, `concurrent-publishers`, `atomicity` |
| G7 Clear contracts | `wagering-http`, `wallets-http`, `sqs-dlq`, the `src/contracts` specs |
| G8 Operable | `observability`, `operational`, `reconciliation`, `shutdown` |
| G9 Reproducible | the task 02 and task 13 fresh-clone checks; per-spec database and queues; `infrastructure.ts` fails when a dependency is missing |

#### Test matrix (challenge §13, concurrency)

| # | Scenario | Channel | Processes | Fault point | Key assertions | File |
|---|---|---|---|---|---|---|
| 1 | Same bet 50× | HTTP | 3 | — | one debit; one transaction ID; same snapshot | `duplicate-bet` |
| 2 | Contended balance | HTTP | 3 (bets on 2 of them) | — | 1 processed, 1 `INSUFFICIENT_FUNDS`, 20.00 | `balance-contention` |
| 3 | Distinct wallets in parallel | HTTP + SQS | 3 | — | every wallet reconciles | `parallel-wallets` |
| 4 | ≥ 3 processes | all | ≥ 3 | — | distinct PIDs asserted in every concurrency spec | all |
| 5 | Killed after commit, before ack | SQS | 3 | `crash-after-commit` | survivor `inbox_duplicates_total` + 1; queue, in-flight, and DLQ empty; one entry, one inbox row | `crash-after-commit` |
| 6 | Two publishers, same outbox | outbox | 2 + 1 killed | `crash-after-send` | every event published; duplicates share `eventId` | `concurrent-publishers` |
| 7 | Reversal before reference | HTTP + SQS | 3 | — | 202, then processed; one reversal | `out-of-order` |
| 8 | Restart with final consistency | all | 3 + 3 | `SIGKILL` all | no pending work left; all reconcile | `restart-recovery` |

#### Requirement-to-test table

| Challenge section | Requirement | Tests |
|---|---|---|
| challenge §5 | No `number` for money; no negative balance; no direct balance update; append-only ledger | `money.spec`, `schema-constraints`, `commit-consistency` |
| challenge §6.1 | `Money` scale, rounding, invalid input | `money.spec`, `primitives.spec` |
| challenge §6.2 | `Wallet` invariants and version | `wallet.spec` |
| challenge §6.3 | Transaction states and factories | `wager-transaction.spec`, `schema-constraints` |
| challenge §6.4 | Immutable ledger entry | `wallet-ledger-entry.spec`, `schema-constraints` |
| challenge §6.5 | Inbox and outbox | `inbox-redelivery`, `outbox-publisher` |
| challenge §7 | Kind rules, references, failure codes | `settle.spec`, `reversals`, `wagering-http` |
| challenge §7.1 | Out-of-order references | `pending-references`, `out-of-order` |
| challenge §8 | Per-wallet serialization and the mandatory scenario | `balance-contention`, `duplicate-bet` |
| challenge §9 | Routes, statuses, reconciliation, health | `wallets-http`, `wagering-http`, `reconciliation`, `operational`, `observability` |
| challenge §10 | SQS idempotency, retry, DLQ | `inbox-redelivery`, `sqs-dlq`, `sqs-ordering`, `crash-after-commit` |
| challenge §11 | Outbox and minimum events | `outbox-publisher`, `concurrent-publishers` |
| challenge §12 | Logs and the seven metric categories | `observability` |
| challenge §13 | Unit, integration, concurrency layers | unit specs under `src/`, `test/integration/`, `test/concurrency/` |

#### Commands

| Command | Runs |
|---|---|
| `bun run check` | typecheck, lint (including the layer rule), format check, unit tests |
| `bun run test:integration` | build, then `test/integration/` against compose PostgreSQL and MiniStack |
| `bun run test:concurrency` | build, then `test/concurrency/`, spawning its own processes |
| `bun run test:all` | all three layers |

--------------------------------------------------------------------------------

*Drafted with EGM*
