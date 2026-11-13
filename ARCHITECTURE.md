# Architecture

This document describes the Distributed Wagering Processor: what it guarantees, how, and at what cost. The main body describes the current design, organized by the evaluation areas of the challenge. Appendix A keeps the decision log in chronological order, including decisions that were later replaced.

*   **Status:** every mandatory requirement is implemented and tested (tasks 01–13 on the [project board](https://github.com/users/joaoalberto-dev/projects/3)); §7 maps each requirement to its tests and records a full run. The Stretch items of task 14 are built too: the CI job for the integration and concurrency layers, the three further reconciliation issues, `settlement_on_reversed_reference_total`, `bun run demo`, and `bun run dlq:redrive`; load testing is not. Where code and this document disagree, the disagreement is a bug in one of them.
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
*   Issues, each `{ code, details? }`, in this order:

    | Code | Found when | `details` |
    |---|---|---|
    | `BALANCE_MISMATCH` | the stored balance differs from the signed sum of the entries | — (the amounts are in the report) |
    | `VERSION_MISMATCH` | the stored version differs from the highest entry version, or from 1 with no entries | `storedVersion`, `expectedVersion` |
    | `CHAIN_GAP` | the versions are not contiguous, or the first is not 1 with an `OPENING` entry (2 without one) | `expectedFirstVersion`, `firstVersion`, `missingVersions` (the first 100) |
    | `CHAIN_BREAK` | the first `balance_before` is not 0, or a `balance_before` differs from the previous `balance_after` | `startsAtZero`, `brokenLinks` |

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
    *   One exception, which never waits: before a pending row's TTL, the reference worker claims the row with `SKIP LOCKED` and then the wallet with `SKIP LOCKED`. A worker that holds the row never waits for anything, so it cannot close a cycle; at the TTL it takes the wallet first, like every other writer.
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
    *   The application moves a message itself: it sends the body unchanged to the DLQ with the original group, the source SQS `MessageId` as its deduplication ID, and the attributes `failureReason`, `receiveCount`, `instanceId`, and `errorClass` (`contention`, `outage`, `unexpected`, or `permanent`), then deletes the original.
    *   `sqs_dlq_moves_total{reason}` counts successful DLQ send calls, including resends accepted within the FIFO deduplication window. It increments before source deletion.
    *   A failed delete, visibility change, or DLQ move is logged and left to the visibility timeout: the message comes back as an inbox duplicate, or is moved again and dropped by the DLQ's deduplication window.
    *   Native redrive at 50 receives is only a backstop for processes that die before classifying.
*   **Redrive procedure.** Messages whose `failureReason` is `RETRY_BUDGET_EXHAUSTED`, or `UNEXPECTED_ERROR` after its cause is fixed, can be moved back to the input queue unchanged; the inbox and the identities make that safe. Permanent reasons (`VALIDATION_FAILED`, identity conflicts, `MESSAGE_ID_CONFLICT`, `WALLET_NOT_FOUND`) are not redriven: the same message would fail the same way, and the provider has to send a corrected operation.
    1.  **Remove the cause.** For `RETRY_BUDGET_EXHAUSTED`, check that `circuit_state` is closed and that `wallet_lock_timeouts_total` has stopped growing for the wallets involved. For `UNEXPECTED_ERROR`, deploy the fix first; otherwise the message returns to the DLQ on its 3rd receive.
    2.  **Read the DLQ.** `ReceiveMessage` on `wager-transactions-dlq.fifo` with `MessageAttributeNames: ["All"]`, `MessageSystemAttributeNames: ["MessageGroupId"]`, and a visibility timeout long enough for the next two steps. FIFO order holds in the DLQ, so a group's messages arrive in their original order.
    3.  **Send each redrivable message** to `wager-transactions.fifo` with `SendMessage`: the body unchanged, the same `MessageGroupId`, and a new `MessageDeduplicationId` derived from the DLQ message's own SQS `MessageId`, such as `<MessageId>-redrive`. Reusing the original ID is unsafe: inside the input queue's 5-minute deduplication window, SQS accepts the send and drops the message. The DLQ `MessageId` is new for every DLQ copy, so a message that fails again and is redriven again is never dropped; a resend of the same copy is dropped, and that copy is already in the input queue. The envelope `messageId` in the body is unchanged, so the inbox still recognizes the message. A new message starts at receive 1 with its full budget.
    4.  **Delete it from the DLQ** with its receipt handle, only after the send succeeded. If the operator stops between the two steps, the message is in both queues; redriving it again is safe, because the inbox and the identities give the two copies one effect.
    5.  **Check the outcome.** The operation's status is readable with `GET /providers/:providerId/wagering/transactions/:externalTransactionId`; `sqs_dlq_depth` should fall, and `sqs_dlq_moves_total` should not grow again.

    Permanent messages are reported to the provider and left to expire: the setup keeps the SQS default retention of 4 days on the DLQ. `bun run dlq:redrive` automates steps 2 to 4: it redrives `RETRY_BUDGET_EXHAUSTED` by default, adds `UNEXPECTED_ERROR` with `--include-unexpected`, lists without moving with `--dry-run`, and leaves every other message in the DLQ, visible again when it ends. A FIFO DLQ hides the rest of a group while one of its messages is in flight, so the messages behind a skipped one in the same group wait for that one to be handled.

### Transactional outbox

*   **Atomicity.** Events are written to `outbox` in the same transaction as the transaction row, the wallet, the ledger entry, and the inbox row. Nothing is published before commit.
*   **Publishing cycle.** `PublishOutbox` runs one short transaction: it selects up to 10 due rows with `FOR UPDATE SKIP LOCKED`, sends them with `SendMessageBatch` inside that transaction, and records each entry with the domain `OutboxMessage` (`markPublished`, or `scheduleRetry` with backoff). A trigger makes `published_at` write-once.
    *   The publisher loop starts when `OUTBOX_PUBLISHER_ENABLED`. It runs the next cycle at once after a full batch, and otherwise waits 500 ms. It skips cycles while the `postgres` or the `sqs` circuit is open.
    *   The send is one attempt (`maxAttempts: 1`, on an SQS client of its own), aborted after 5 s, through the `sqs` circuit. If the whole call throws, the transaction rolls back and no attempt is counted.
    *   An entry that SQS refuses, or leaves out of its answer, is rescheduled with its reason in `last_error`. A sender fault (a malformed entry) also logs an error with the event's IDs and increments `outbox_sender_faults_total`.
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
*   **Two workers on one row.** Workers coordinate without a lease. Before the TTL, an attempt first claims its row with `FOR UPDATE SKIP LOCKED`: a second worker that selected the same row finds it taken and skips it. Only the worker that holds the row and finds the wallet busy pushes the row back by 1 s, uncounted, so a push-back never cancels another worker's attempt in progress.
*   **Other errors.** Contention skips the row, which stays due and uncounted. An outage ends the cycle, and the polling loop waits while the `postgres` circuit is open. An unexpected error before the TTL counts the attempt and reschedules the row.

### Crash, outage, and shutdown

*   **Killed after commit, before ack.** The message is redelivered after the visibility timeout; a survivor finds the inbox row and acknowledges it as a duplicate.
*   **SQS or PostgreSQL outage.**
    *   Each dependency has a circuit breaker that counts only Outage errors.
    *   While it is open, the polling loops that need it skip their cycles. Messages are not received, so retry budgets are not consumed.
    *   After the open period, the next normal cycle is the probe. While a circuit is half-open, the consumer's receive is a short poll, so its probe settles at once instead of holding the circuit half-open, and refusing the process's other calls, for a 20 s long poll.
    *   HTTP keeps committing during an SQS outage, the outbox backlog and `outbox_lag_seconds` grow, and the backlog drains afterwards with the original `eventId`s.
*   **Restart.** All state lives in PostgreSQL and the queues. After a restart, pending references, unpublished events, and in-flight messages are picked up by whichever instance runs first.
*   **`SIGTERM`.**
    1.  The consumer stops polling, finishes the message in progress in each group within 20 s, and releases the unstarted ones with visibility 0.
    2.  The publisher and the worker finish their current cycle.
    3.  Readiness returns 503, naming `shutdown`, from the start of shutdown until the HTTP server closes. The flag is set in `onModuleDestroy`, which Nest runs before any drain, and the HTTP server keeps serving until the drain ends.

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

### Test matrix (challenge §13, concurrency)

Every concurrency spec starts its own processes from the build and asserts that their PIDs are distinct.

| # | Scenario | Channel | Processes | Fault point | Key assertions | Spec |
|---|---|---|---|---|---|---|
| 1 | Same bet 50 times in parallel | HTTP | 3 | — | one debit; one transaction ID; the same balance snapshot in every answer | `duplicate-bet` |
| 2 | Two bets of 80.00 on 100.00 (challenge §8) | HTTP | 3 (the bets go to 2 of them) | — | one `PROCESSED`, one `INSUFFICIENT_FUNDS`; balance 20.00; one debit | `balance-contention` |
| 3 | 30 wallets × 20 bets in parallel | HTTP + SQS | 3 | — | every bet processed; exact balance and version; every wallet reconciles | `parallel-wallets` |
| 4 | At least 3 processes | all | ≥ 3 | — | distinct PIDs, asserted by the cluster helper in every spec | all |
| 5 | Consumer killed after commit, before the ack | SQS | 3 | `crash-after-commit` | a survivor's `inbox_duplicates_total` grows by 1; queue, in-flight, and DLQ empty; one ledger entry, one inbox row | `crash-after-commit` |
| 6 | Two publishers on one outbox | outbox | 2, plus 1 killed after its send | `crash-after-send` | all 300 events published; the interrupted batch keeps its `eventId`s; no row published twice by the two | `concurrent-publishers` |
| 7 | 20 reversals before their bets | HTTP + SQS | 3 | — | `202`, then `PROCESSED` through the wake-up; each bet reversed once | `out-of-order` |
| 8 | `SIGKILL` of every process under 500 mixed operations, then 3 new processes | HTTP + SQS | 3 + 3 | `SIGKILL` of all | within 60 s: no pending reference, no unpublished event, empty queue and DLQ; exact balance and version; every wallet reconciles | `restart-recovery` |

Beyond the eight scenarios:

| Scenario | Spec | Key assertions |
|---|---|---|
| Hot wallet: 200 bets on one wallet beside 10 quiet wallets | `hot-wallet` | the excess is shed with `503` and nothing is stored for it; the quiet wallets complete; the `postgres` circuit stays closed |
| 20 credits of 100.00 with 999.99 of headroom | `ceiling-credits` | 9 processed, 11 `BALANCE_LIMIT_EXCEEDED`; the ceiling is never passed |
| SQS unreachable for 60 s under HTTP traffic | `sqs-outage` | HTTP keeps committing; no receive budget spent; every event published afterwards with its original `eventId` |
| 20 reconciliations during 300 writes | `reconcile-during-writes` | every one answers `consistent: true` with no issues |

### Challenge §13 checklist

| Layer | Required by challenge §13 | Specs |
|---|---|---|
| Unit | `Money` operations and validation (scale, rounding, invalid input) | `money.spec`, `primitives.spec` |
| Unit | `Wallet` invariants | `wallet.spec` |
| Unit | `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` rules | `settle.spec`, `transaction-kind.spec`, `wager-transaction.spec`, `wager-operation.schema.spec` |
| Unit | Currency conflict | `settle.spec` (`CURRENCY_MISMATCH`) |
| Unit | Idempotency key with a different payload | `payload-hash.spec`, `submit-wager-transaction.spec` |
| Integration | Migrations and constraints | `migrations`, `schema-constraints`, `commit-consistency` |
| Integration | Atomicity of wallet, ledger, inbox, and outbox | `atomicity`, `unit-of-work` |
| Integration | Inbox and redelivery | `inbox-redelivery`, `sqs-ordering` |
| Integration | Concurrent publishers on one outbox | `outbox-publisher`; `concurrent-publishers` across processes |
| Integration | Retry and DLQ | `sqs-dlq`, `sqs-ordering`; `sqs-retry-policy.spec` for the budgets |
| Integration | Recovery after a restart | `shutdown` (a second process takes over the released messages); `crash-after-commit` and `restart-recovery` across processes |
| All | `wallet.balance` equals the balance rebuilt from the ledger | `expectReconciled` at the end of every spec that moves money |

### Requirement-to-test table

| Challenge section | Requirement | Specs |
|---|---|---|
| §5 | No `number` for money; no negative balance; no direct balance update; append-only ledger | `money.spec`, `schema-constraints`, `commit-consistency` |
| §6.1 | `Money` scale, rounding, and invalid input | `money.spec`, `primitives.spec` |
| §6.2 | `Wallet` invariants and version | `wallet.spec` |
| §6.3 | Transaction states and factories | `wager-transaction.spec`, `schema-constraints` |
| §6.4 | Immutable ledger entry | `wallet-ledger-entry.spec`, `schema-constraints` |
| §6.5 | Inbox and outbox | `inbox-redelivery`, `outbox-publisher`, `outbox-message.spec` |
| §7 | Kind rules, references, and failure codes | `settle.spec`, `reversals`, `wagering-http` |
| §7.1 | Out-of-order references | `resolve-pending-references.spec`, `pending-references`, `worker-race`, `out-of-order` |
| §8 | Per-wallet serialization and the mandatory scenario | `balance-contention`, `duplicate-bet`, `hot-wallet` |
| §9 | Routes, statuses, reconciliation, and health | `wallets-http`, `wagering-http`, `reconciliation`, `operational`, `observability` |
| §10 | SQS idempotency, retry, and DLQ | `inbox-redelivery`, `sqs-dlq`, `sqs-ordering`, `crash-after-commit`, `sqs-outage`, `redrive-dlq` |
| §11 | Outbox and the minimum events | `outbox-publisher`, `concurrent-publishers`, `wager-events.spec` |
| §12 | Logs and the seven metric categories | `observability`, `metrics.spec`, `json-logger.spec` |
| §13 | Unit, integration, and concurrency layers | the checklist above |

Unit specs are under `src/` next to their source; the others are `test/integration/<name>.spec.ts` and `test/concurrency/<name>.spec.ts`. `platform.spec` keeps the platform checks of task 02 (MikroORM 7 and `pg` on Bun, MiniStack's FIFO behavior, `@nestjs/resilience`, `transaction_timeout`, the app role's grants) as a regression test.

### Test evidence

A full run of `bun run test:all` on 2026-11-12, from commit `7bac3fb` (task 14) on an 8-core AMD Ryzen 7 5700X3D with 60 GiB of memory, Linux, Bun 1.4.4, and the compose PostgreSQL 17.11 and MiniStack 1.5.39:

| Layer | Specs | Tests | Result | Test time |
|---|---|---|---|---|
| Unit | 35 | 459 | all pass | 0.5 s |
| Integration | 22 | 231 | all pass | 71 s |
| Concurrency | 11 | 11 | all pass | 100 s |

The whole command, with the two builds, took 2 min 58 s. Task 12 required `test:all` to pass three times in a row; it did on the same machine the same day, from commit `2f58ab8`, with integration and concurrency times between 67 s and 103 s. The first run for this record failed once, in `outbox-publisher`, on a race in the spec itself; decision 40 describes it and its fix.

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

    Also: `pending_references`, `reference_failed_total`, `reconciliation_divergences_total`, `settlement_on_reversed_reference_total` (a `WIN` or `LOSS` processed against a reversed `BET`, counted with its warning log), `bulkhead_rejections_total`, `circuit_state`, and the pool gauges `db_pool_in_use` and `db_pool_waiting`.

    *   **Lock conflicts.** `wallet_lock_wait_seconds{channel}` times each waiting wallet lock; a lock that times out is counted by `wallet_lock_timeouts_total` (`55P03`) instead. `statement_timeouts_total` counts `57014`. Both come from the unit of work and the query port, through a `PersistenceObserver` the metrics implement.
    *   **Gauges at scrape.** `outbox_pending`, `outbox_lag_seconds` (age of the oldest unpublished event), `pending_references`, and `sqs_dlq_depth` are read when `/metrics` is scraped, each read with a 1 s timeout and outside the circuits. Only instances that run the publisher or the worker expose them, so scraping every instance does not multiply the load; dashboards take the `max`. A read that fails reports `NaN`, which `max` skips, rather than a stale or a zero value; the scrape itself still answers. The pool gauges are read last, so the scrape's own reads are not counted.
*   **Health.** `/health/live` checks only the process. `/health/ready` checks PostgreSQL, SQS, and that the latest migration is applied, each with a 1 s timeout. A failing check answers 503 with a body that names it (`postgres`, `sqs`, or `migrations`). While draining, it answers 503 naming `shutdown` and checks no dependency. Neither requires authentication.
    *   The expected migration is `LATEST_MIGRATION` in `src/infrastructure/persistence/schema-version.ts`, because the build compiles only `src/`; `migrations/index.ts` re-exports it, and the migrations spec checks that it names the last migration.
*   **Request context.** Every request gets a new `X-Request-Id`. An incoming `X-Correlation-Id` of 1–128 characters from `[A-Za-z0-9._:-]` is kept, and any other value is replaced by a new UUIDv7. Both are returned as response headers and carried into every log line of the request.
*   **Readiness and routing.** Readiness covers SQS, as challenge §9 requires. In the shipped topology nothing routes on readiness, so HTTP keeps serving during an SQS outage. A production setup behind a load balancer would split HTTP readiness from consumer readiness.

### Diagnosing operations, pending work, and failures

Each instance serves `/metrics` and `/health/*`; gauges of shared state come from instances that run the publisher or the worker, so take their `max`. Logs are JSON lines; filter them by the IDs below.

| Question or symptom | Where to look | What it means, and what to do |
|---|---|---|
| What happened to one operation? | `GET /providers/:providerId/wagering/transactions/:externalTransactionId` or `GET /wagering/transactions/:id`; logs by `correlationId`, `requestId`, `transactionId`, `messageId`, or `sqsMessageId` | The stored status and failure code are the answer; a `503` was never decided and is safe to resend with the same key. |
| Is a wallet consistent? | `POST /wallets/:walletId/reconciliation`; `reconciliation_divergences_total{issue}` | Any issue means a write bypassed the rules. Reconciliation reports and never corrects; investigate the ledger with `GET /wallets/:walletId/ledger`. |
| Is an instance ready? | `GET /health/ready` | A 503 body names the failing check: `postgres`, `sqs`, `migrations` (run the migrations), or `shutdown` (the instance is draining). |
| Is a dependency down? | `circuit_state{dependency}` (2 open, 1 half-open); `statement_timeouts_total` | While a circuit is open, the loops that need it pause and spend no retry budget; HTTP keeps serving if PostgreSQL is up. |
| Are events late? | `outbox_lag_seconds`, `outbox_pending`, `outbox_publish_attempts_total{result}`, `outbox_sender_faults_total` | A rising lag with `retry` results is an SQS problem; a sender fault is a malformed event, logged with its IDs and retried every 5 minutes. `outbox.last_error` holds the broker's reason. |
| Are reversals waiting for their references? | `pending_references`, `reference_attempts_total{outcome}`, `reference_failed_total` | Rows wait up to the TTL (24 h); growth without `processed` outcomes means references are not arriving. |
| Are SQS messages failing? | `sqs_retries_total{error_class}`, `sqs_dlq_moves_total{reason}`, `sqs_dlq_depth`; DLQ attributes `failureReason`, `errorClass`, `receiveCount`, `instanceId` | Redrive `RETRY_BUDGET_EXHAUSTED`, and `UNEXPECTED_ERROR` once fixed (§5); never permanent reasons. |
| Is a wallet hot, or the database saturated? | `wallet_lock_wait_seconds{channel}`, `wallet_lock_timeouts_total`, `bulkhead_rejections_total{group}`, `db_pool_in_use`, `db_pool_waiting` | Lock timeouts on one wallet are expected under a burst and answer `503`; pool waits and bulkhead rejections across wallets mean the instance needs more capacity. |
| Are retries replaying correctly? | `idempotent_replays_total`, `inbox_duplicates_total`, `idempotency_conflicts_total`, `message_id_conflicts_total` | Conflicts mean a provider reused a key or a `messageId` for another operation. |
| Is it slow? | `wager_processing_duration_seconds{channel}` | Compare with lock waits: most latency under contention is the wallet lock. |

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
| Platform behavior on Bun (MikroORM 7, MiniStack, `@nestjs/resilience` 0.0.3) | Guarantees that depend on it fail | Every item of the platform spike passed, so no fallback was needed; `platform.spec` keeps them as a regression test for upgrades. |
| SQS behavior is verified only against MiniStack | AWS SQS may differ in deduplication, visibility, throttling, or batch answers | The design relies only on documented SQS FIFO behavior, and `platform.spec` checks each behavior it uses; a run of the integration and concurrency layers against AWS SQS belongs before production. |
| Tests wait on conditions with fixed limits (for example 60 s for recovery) | A much slower machine can fail a spec that would pass with more time | The limits are well above the measured times in §7; each one is named in its timeout error. |
| No load test | Throughput, tail latency, and the instance count a given load needs are unmeasured | Out of scope (below); the metrics in §8 are what a load test would read. |

### Non-goals

*   Partial reversals: a reversal must match the referenced amount.
*   Round state: whether a round is open, settled, or cancelled belongs to the provider.
*   Per-currency rules: every currency has two decimals and the same ceiling.
*   Event ordering beyond what FIFO groups give per wallet; `walletVersion` lets consumers order balance events.
*   Retention of inbox and outbox rows.
*   Implemented authentication (designed in §6).
*   Future extensions, documented but not built: SNS fan-out, a provider registry, ledger balance checkpoints, OpenTelemetry tracing, dashboards.
*   Load testing; if built, it runs as `bun run test:load`.

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
| 37 | Concurrent outbox publishing (task 10), listed below this table. | Decided |
| 38 | Observability and health checks (task 11), listed below this table. | Decided |
| 39 | Recovery across multiple instances (task 12), listed below this table. | Decided |
| 40 | Documentation and the delivery demonstration (task 13), listed below this table. | Decided; "redrive without a script" **Superseded** by 41 |
| 41 | Stretch items (task 14), listed below this table. | Decided; refines the step 3 example of 40 |
| 42 | The reference worker claims its row before the wallet, found by CI job 2; listed below this table. | Decided; adds an exception to the lock-order invariant of 9 |

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

Decision 37 settled these points:

*   **Batch entry IDs.** The `SendMessageBatch` entry `Id` is the entry's position. SQS restricts batch IDs, and the `eventId` stays the deduplication ID.
*   **Unanswered entries.** An entry missing from both `Successful` and `Failed` counts as a failed send and is rescheduled, never as published.
*   **Failure reasons.** The broker's reason, cut to 500 characters, is kept in `last_error`. The sender-fault log line carries the event's IDs and type only, because the broker's text can quote the body.
*   **Fault point.** `crash-after-send` sends `SIGKILL` once `SendMessageBatch` returns, before the results are recorded, so the rows stay unpublished with no attempt counted.
*   **Tests.**
    *   Every spawned process now runs the publisher, and the shared `wagering_test` database had a backlog of about 41,000 unpublished events from earlier runs. Each test process therefore marks earlier events as published once before its first spec, and the outbox specs do the same before their in-process tests. That way each spec's publishers claim its own events first.
    *   `concurrent-publishers` commits the 300 events from a process without the publisher. Then the crashing process starts alone, sends the first batch, and dies; the spec reads that batch from the queue. Then the two publishers start together, so four distinct PIDs take part.
    *   MiniStack's FIFO deduplication window drops the republished batch, so no duplicate reaches the queue in that run. The spec simulates a republish after the window by resending the crashed batch under new deduplication IDs, and checks that a reader that removes duplicates by `eventId` still sees each event once.
    *   The hot-wallet burst lasts under half a second, which is shorter than the publisher's idle poll. So `hot-wallet` asserts that every event of the burst and the quiet wallets is published within 15 s, with the `sqs` circuit closed and no sender fault, rather than that events arrive while the burst runs.
    *   `WagerTransactionFailed` needs an unexpected error at the reference TTL, so it is covered by the application and domain specs, not over the wire.

Decision 38 settled these points:

*   **Lock-wait channel.** `UnitOfWorkOptions` gained an optional `channel`, passed only by the units of work that lock a wallet (the decision step of `SubmitWagerTransaction`, and the worker's attempt and `FAILED` steps). The wallet repository times the waiting lock and reports it through the unit of work's observer. A skip-locked read never waits and is not timed.
*   **Gauges owned by `DatabaseGauges`.** prom-client always exposes an unlabelled gauge, so a gauge cannot be dropped on a failed read. `DatabaseGauges` therefore registers the shared gauges only on publisher or worker instances, and sets `NaN` on a failed read; prom-client prints it as `Nan`, which Prometheus parses in any case.
*   **Draining.** Terminus marks its own shutdown in `beforeApplicationShutdown`, whose order relative to the consumer's drain depends on module order. A `ShutdownState` provider is set in `onModuleDestroy` instead, which runs on every module before any drain.
*   **Half-open probe.** The SQS outage spec showed processes left half-open after recovery: the consumer's first call was a 20 s long poll on an empty queue, and the circuit refused the publisher's sends until it returned. The consumer now short-polls while any circuit it needs is half-open.
*   **Tests.**
    *   `test/support/tcp-proxy.ts` sits between spawned processes and PostgreSQL or MiniStack; `cut()` terminates every connection and refuses new ones. A cluster can take its environment as a function, so its processes get the proxy's port, known only once the spec's hooks ran.
    *   `observability` checks each required category over the wire on one process, with the publisher off so the backlog stays visible until a publisher process starts. `statement_timeouts_total` needs a statement that outruns its timeout, which no route causes, so the unit-of-work spec covers it with a transaction-local `statement_timeout`; `unique_violation_retries_total` and `reconciliation_divergences_total` stay covered by their application specs.
    *   The log check parses every JSON line of the process and fails on a key named `amount`, `balance`, `money`, or `payload`, on any string value shaped like an amount, and on the spec's own amounts anywhere in the output.
    *   `shutdown` holds the four wallets' row locks so each group's first message is in progress when `SIGTERM` arrives, with a lock timeout longer than the hold. It checks that exactly those four commit before the exit and that the other 16 are visible again at once, well before their 30 s visibility timeout.
    *   `sqs-outage` sends its waiting messages to the input queue directly, not through the proxy, and shows that no receive budget was spent by finding them all still visible, with none in flight, at the end of the 60 s outage.

Decision 39 settled these points:

*   **Restart without a crash hook.** `restart-recovery` uses no fault point. The three processes get `SIGKILL` once 200 of the 500 operations were answered, with up to 40 requests in flight, so the kill can land in a commit, a receive, a publisher send, or a worker cycle. Recovery relies only on what a restart already gives: PostgreSQL rolls back the open transactions, messages in flight come back after their visibility timeout (5 s in this spec), and unpublished outbox rows and due pending references are picked up by the new processes.
*   **The provider's side of a crash.** An HTTP request that lost its connection, or got a 503, has an unknown outcome, so the spec resends it to the new processes with the same key, as a provider would. Some of those were committed before the kill and answer as replays. The spec asserts that at least one request was interrupted, so it never passes against an idle cluster.
*   **Mixed traffic.** Each group of five operations on a wallet has a bet that is won, a bet that is refunded, and either a rollback of the win or a loss. Two groups in three send the dependents first, so pending references exist when the kill happens and must be resolved by the wake-up and the workers of the new processes. Every operation is valid with enough funds in any order, so each wallet ends at an exact balance and version (`985.00`, version 46) that a duplicated or lost effect would change.
*   **The 60 s window** starts when the new processes are ready and covers the resends and the rest of the traffic. Within it the spec waits for no `PENDING_REFERENCE` row, no unpublished outbox row, and no visible or in-flight input message for its wallets; then it checks the DLQ is empty, all 500 operations are `PROCESSED`, and every wallet reconciles.
*   **Reconciliation during writes.** `reconcile-during-writes` sends reconciliation `k` once `10 + 12k` of 300 writes were answered, so all 20 are sent while writes are in flight, and checks that most of them also answered before the writes ended. Each must answer `consistent: true` with no issues.

Decision 40 settled these points:

*   **Where the test evidence lives.** The test matrix, the challenge §13 checklist, the requirement-to-test table, and a recorded run are in §7, next to the test strategy, rather than in a separate document.
*   **Redrive without a script.** The redrive procedure in §5 names the SQS calls and their parameters instead of commands of one tool, so it holds for the AWS CLI, an SDK, or the console. It sends each message as a new one with a new deduplication ID and deletes the DLQ copy last, because reusing the original ID inside the deduplication window loses the message silently.
*   **The demonstration.** The `README.md` demo uses only `curl` and Bun against the three containers of the `app` profile, sending each step to a different instance. Every identifier carries a per-run prefix, so the demo can be run again without resetting the database.
*   **A race in a test.** The first full run for the evidence failed once in `outbox-publisher`: the publisher sends before it commits, so the spec could see every event on the queue while the last rows were still unpublished. The spec now waits for the rows, as a consumer would; the publisher is unchanged.

Decision 41 settled these points:

*   **Reconciliation details.** `CHAIN_GAP` lists at most the first 100 missing versions, computed in SQL with `generate_series`, so a corrupted version far above the rest cannot make a large answer; the issue itself does not depend on the list. `CHAIN_BREAK` carries counts, not amounts, like the log line. The domain report checks all four issues from one set of aggregates, which the reader port now returns as the domain's own type.
*   **Where the reversed-settlement counter is raised.** Next to the warning log, after the commit, in `SubmitWagerTransaction` and `ResolvePendingReferences`, not in `applyOutcome`: inside the transaction a rollback or retry would count a settlement that did not happen, and a replay never reaches either place.
*   **The redrive deduplication ID.** The script derives it from the DLQ message's SQS `MessageId` instead of the envelope `messageId` with a counter (the example in decision 40). A counter repeated inside five minutes would let SQS drop a message the script then deletes from the DLQ; the DLQ `MessageId` changes with every DLQ copy and stays the same only for a resend of one copy, which is already in the input queue. Messages SQS moved itself, with no `failureReason`, are not redriven: nothing says why they failed.
*   **The demo script.** `bun run demo` checks its own outcomes and exits with the number of failed checks, so it doubles as a smoke test of the three containers. It sends HTTP steps round-robin and resends a `503` or a refused connection to the next instance with the same key. The crash step waits for Docker to report the killed container stopped before starting it again, because `docker compose start` does nothing while the container still reads as running.
*   **CI job 2.** PostgreSQL and MiniStack run as service containers. A service container takes no command, so `max_connections = 200` is set with `ALTER SYSTEM` and a restart, and MiniStack's health is polled in a step instead of a container health command.

Decision 42 settled these points:

*   **The defect.** Two workers could select the same due row. The one that locked the wallet went on with its attempt; the other found the wallet locked, took it for a busy wallet, and pushed the row back by 1 s. Under READ COMMITTED the first worker's reschedule then saw a row that was no longer due and dropped its attempt. The two workers poll on the same period, so once they met they kept meeting: the attempt count stayed put and the row was retried about every second instead of backing off. Money was never at risk: a decision still applied, and the TTL still decided the row. The timing-based `pending-references` spec caught it on CI runners, whose slower round trips widen the window, and not on a development machine.
*   **The fix.** Before the TTL, an attempt claims its row with `FOR UPDATE SKIP LOCKED` before the wallet, also with `SKIP LOCKED`; a worker that cannot claim the row skips it without touching it. At the TTL the order stays wallet first, then the row with a waiting `FOR UPDATE`. The lock-order invariant gains an exception for the non-waiting order, since a worker that holds the row never waits.
*   **The regression test.** `worker-race` forces the interleaving against PostgreSQL instead of relying on timing: two in-process applications, and the second worker's whole cycle runs while the first holds the wallet lock. It failed on every run before the fix. The in-memory fake cannot show the defect, because each fake unit of work works on its own copy and never sees another's commit; the unit spec covers the claim decision only.
*   **The rule it leaves.** When an attempt decides under a lock and then writes with a "still due" condition, a competing path must not be able to change that condition without the same lock.
