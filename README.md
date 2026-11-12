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
| `bun run check` | Type check, lint, format check and unit tests: what CI runs |

## Tests

```bash
bun run test               # unit tests, next to the code in src/
bun run test:cov           # unit tests with coverage
bun run test:integration   # builds, then runs test/integration/ against PostgreSQL and MiniStack
bun run test:concurrency   # builds, then runs test/concurrency/
bun run test:all           # all of the above
```

Integration and concurrency tests need `docker compose up -d postgres ministack setup` first; they fail, never skip, when a dependency is missing. They use their own database, `wagering_test`, and create their own queues, so they never touch development data.
