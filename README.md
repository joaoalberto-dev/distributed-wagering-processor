# Distributed Wagering Processor

A wagering processing service built with NestJS and TypeScript on Bun, focused on reliability and scalability: game providers report operations over HTTP and an SQS FIFO queue, each operation is applied to the player's wallet exactly once, and every balance change is recorded in an append-only ledger.

The design is in [ARCHITECTURE.md](ARCHITECTURE.md).

[GitHub repository](https://github.com/joaoalberto-dev/distributed-wagering-processor)
[Project](https://github.com/users/joaoalberto-dev/projects/3)

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Compose v2. No cloud account or token is needed: SQS runs locally in [MiniStack](https://github.com/ministackorg/ministack).
- [Bun](https://bun.sh) 1.4.4.

## Getting started

```bash
bun install
docker compose up -d postgres ministack setup   # PostgreSQL, SQS and the one-shot setup
bun run start:dev                                # the app on http://localhost:3000
```

`setup` runs the migrations as the owner role, creates the `wagering_app` role (`SELECT`, `INSERT` and `UPDATE` only), and creates the queues `wager-transactions.fifo`, `wager-transactions-dlq.fifo` and `wagering-events.fifo`. It is idempotent, so running it again is safe.

Application DLQ sends deduplicate by the source SQS `MessageId`. `sqs_dlq_moves_total{reason}` counts accepted sends, including deduplicated resends, before the source message is deleted.


To run three instances from the built image, on ports 3001 to 3003:

```bash
docker compose --profile app up -d --build
curl http://localhost:3001/health/live
```

The defaults match the compose services, so no `.env` is required. [.env.example](.env.example) lists every variable.

## Scripts

| Script | What it does |
|---|---|
| `bun run start:dev` | Runs the source with watch mode |
| `bun run build` | Compiles `src/` to `dist/` |
| `bun run start:prod` | Runs the build |
| `bun run setup` | The setup script, against the configured database and endpoint |
| `bun run migrate:up` / `bun run migrate:down` | Applies every pending migration / reverts the last one (`bun scripts/migrate.ts down --all` reverts all) |
| `bun run typecheck` | Type-checks everything |
| `bun run lint` | Lints, including the layer dependency rules |
| `bun run format` / `bun run format:check` | Formats / checks formatting |
| `bun run check` | Type check, lint, format check and unit tests: CI job 1 |
| `bun run demo` | Checks the main guarantees against the three `app` containers, including a `SIGKILL` of `app-2` (`--skip-crash` leaves it out) |
| `bun run dlq:redrive` | Moves DLQ messages that failed for a retryable reason back to the input queue (`--include-unexpected`, `--dry-run`; [ARCHITECTURE.md §5](ARCHITECTURE.md#sqs-consumption)) |

## Tests

```bash
bun run test               # unit tests, next to the code in src/
bun run test:cov           # unit tests with coverage
bun run test:integration   # builds, then runs test/integration/ against PostgreSQL and MiniStack
bun run test:concurrency   # builds, then runs test/concurrency/
bun run test:all           # all of the above
```

Integration and concurrency tests need `docker compose up -d postgres ministack setup` first; they fail, never skip, when a dependency is missing. They use their own database, `wagering_test`, and create their own queues, so they never touch development data.

| Layer | Where | Needs | What it proves |
|---|---|---|---|
| Unit | `src/**/*.spec.ts` | nothing | `Money`, `Wallet`, the transaction lifecycle, every business rule in `settle()`, the contracts, retry and backoff policies |
| Integration | `test/integration/` | PostgreSQL and MiniStack | migrations, every constraint and trigger, atomicity, inbox and redelivery, retries and the DLQ, the outbox, reconciliation, metrics, readiness, and the `SIGTERM` drain |
| Concurrency | `test/concurrency/` | the same, plus 3 or more processes it starts itself | the eight scenarios of the challenge (50 copies of one bet, the contended balance, `SIGKILL` after commit, two publishers, reversals before their bets, a restart of every process), a hot wallet, and a 60 s SQS outage |

CI job 2 runs the integration and concurrency layers against PostgreSQL and MiniStack service containers.

[ARCHITECTURE.md §7](ARCHITECTURE.md#7-tests) maps every requirement to its tests and records a full run.

## Demo

`bun run demo` runs contention, replay, an out-of-order reversal, a crash of one instance under SQS traffic, and reconciliation against the three instances, and checks every outcome.

With the three instances of the `app` profile running (see [Getting started](#getting-started)), this walks through the main guarantees with `curl`. Each request goes to a different instance, and every identifier carries a per-run prefix, so the demo can be run again as is. Paste it into `bash` or `zsh`.

```bash
RUN=$(date +%s)
PLAYER=$(bun -e 'console.log(crypto.randomUUID())')

# A wallet with 100.00.
WALLET=$(curl -s -X POST localhost:3001/wallets -H 'Content-Type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" \
  | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
echo "wallet $WALLET"

# wager PORT KIND EXTERNAL_ID AMOUNT [REFERENCE]; the idempotency key is the external ID.
wager() {
  local reference=${5:+,\"referenceExternalTransactionId\":\"$RUN-$5\"}
  curl -s -w '  → HTTP %{http_code}\n' -X POST "localhost:$1/wagering/transactions" \
    -H 'Content-Type: application/json' -H "Idempotency-Key: $RUN-$3" \
    -d "{\"providerId\":\"demo\",\"externalTransactionId\":\"$RUN-$3\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-$RUN\",\"gameId\":\"slots\",\"kind\":\"$2\",\"money\":{\"amount\":\"$4\",\"currency\":\"BRL\"}$reference}"
}

wager 3001 BET    bet-1    30.00         # processed: 70.00
wager 3002 BET    bet-1    30.00         # the same operation on another instance: a replay, same transactionId
wager 3003 BET    bet-1    99.00         # the same key with another payload: 409 IDEMPOTENCY_KEY_CONFLICT
wager 3001 WIN    win-1    45.00 bet-1   # processed: 115.00
wager 3002 BET    bet-2    500.00        # 422 INSUFFICIENT_FUNDS, stored as REJECTED
wager 3003 REFUND refund-3 10.00 bet-3   # its bet has not arrived: 202 PENDING_REFERENCE
wager 3001 BET    bet-3    10.00         # processed: 105.00; wakes the refund, which a worker applies within about 1 s

# A bet of 15.00 over SQS, delivered twice (as at-least-once delivery may): one effect.
RUN=$RUN PLAYER=$PLAYER WALLET=$WALLET bun -e '
import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
const { RUN, PLAYER, WALLET } = process.env;
const sqs = new SQSClient({ endpoint: "http://localhost:4566", region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" } });
const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: "wager-transactions.fifo" }));
const body = JSON.stringify({ messageId: `${RUN}-msg-4`, type: "WagerTransactionRequested",
  occurredAt: new Date().toISOString(), data: { providerId: "demo", externalTransactionId: `${RUN}-bet-4`,
  playerId: PLAYER, walletId: WALLET, roundId: `round-${RUN}`, gameId: "slots", kind: "BET",
  money: { amount: "15.00", currency: "BRL" }, idempotencyKey: `${RUN}-bet-4` } });
for (const copy of [1, 2])
  await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: body, MessageGroupId: WALLET,
    MessageDeduplicationId: `${RUN}-msg-4-copy-${copy}` }));
console.log("sent twice");'

sleep 2
curl -s localhost:3002/providers/demo/wagering/transactions/$RUN-refund-3; echo   # the refund, now PROCESSED
curl -s localhost:3003/providers/demo/wagering/transactions/$RUN-bet-4; echo      # the SQS bet, PROCESSED once
curl -s localhost:3001/wallets/$WALLET; echo                                      # 100.00, version 6
curl -s "localhost:3002/wallets/$WALLET/ledger?limit=10"; echo                   # one entry per balance change
curl -s -X POST localhost:3003/wallets/$WALLET/reconciliation; echo              # "consistent":true
for port in 3001 3002 3003; do                                                   # each instance counts its own work
  curl -s localhost:$port/metrics | grep -E '^(idempotent_replays_total|inbox_duplicates_total|idempotency_conflicts_total)'
done
```

What to look for:

- The first two answers carry the same `transactionId` and `balance` (`70.00`); the second has `"idempotentReplay":true`, although another instance answered it.
- The `REFUND` answers `202` with `"balance":null`, and once its bet arrives it reads `"status":"PROCESSED"`.
- The wallet ends at `100.00`, version 6 (100 − 30 + 45 − 10 + 10 − 15): the rejected bet, the replay, the conflict, and the second SQS delivery moved nothing.
- The ledger has six entries, each `balanceBefore` equal to the previous `balanceAfter`, and reconciliation answers `"consistent":true` with `"issues":[]`.
- Across the three instances, `idempotent_replays_total`, `idempotency_conflicts_total`, and `inbox_duplicates_total` each grew by 1 (counters start at zero when an instance starts).

To see an instance fail and come back, kill one and keep sending to the others; the wallet's state is in PostgreSQL, so any instance answers for it:

```bash
docker compose --profile app kill app-2
wager 3001 BET bet-5 5.00                       # processed by app-1
docker compose --profile app start app-2
until curl -sf localhost:3002/health/ready > /dev/null; do sleep 1; done
curl -s localhost:3002/wallets/$WALLET; echo    # app-2 again, 95.00
```

What each response, metric, and log field means when something goes wrong is in [ARCHITECTURE.md §8](ARCHITECTURE.md#diagnosing-operations-pending-work-and-failures).
