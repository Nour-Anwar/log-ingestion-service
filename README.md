# Log Ingestion and Query Service
 
Service for ingesting, querying, and aggregating structured logs at scale.
 
**Built with:** TypeScript · Express · PostgreSQL · Drizzle ORM · Docker
 
## Features
 
- High-throughput batch log ingestion via `COPY`
- Cursor-based (keyset) pagination
- Daily PostgreSQL partitioning with automatic retention
- Pre-aggregated hourly rollup table for fast aggregation under load
- Free-form JSONB attribute filtering
- Bulk dataset seeding and combined ingestion+query load testing
## Quick Start
 
```bash
git clone https://github.com/Nour-Anwar/log-ingestion-service
cd log-ingestion-service
docker compose up --build
```
 
- API: `http://localhost:8080`
- Postgres: `localhost:5433`
- Migrations run automatically on startup; readiness is signaled via `GET /health`.
**Note:** always use `--build` after pulling new code — reusing a stale local image will run outdated code even though the source is up to date.
 
## Project Structure
 
```
src/
  app.ts, server.ts
  db/
    client.ts, schema.ts, runMigrations.ts, partitions.ts, rollup.ts
    migrations/
      0000_init.sql     # logs table, partitioning, indexes
      0001_rollup.sql   # logs_hourly_counts rollup table
  logs/
    ingest.ts, list.ts, aggregate.ts
    validate.ts, queryValidate.ts, aggregateValidate.ts
scripts/
  seed.ts                  # bulk data generation
  load-test-ingest.ts       # ingestion throughput alone
  load-test-query.ts         # aggregate latency alone
  load-test-combined.ts       # ingestion + aggregate polling, concurrently
tests/                       # vitest + supertest
.github/workflows/            # CI pipeline
```
 
## API
 
### `GET /health`
`200` once the DB is connected, migrations are applied, and the service is ready.
 
### `POST /logs`
```json
{ "logs": [{ "timestamp": "2026-08-01T12:00:00Z", "level": "error", "service": "checkout", "message": "payment declined", "attributes": { "user_id": "42" } }] }
```
- Required: `timestamp` (ISO 8601, ≤5 min in the future), `level` (`debug`/`info`/`warn`/`error`), `service`, `message`.
- Optional: `attributes` — flat object, values are string/number/boolean.
- `200` if ≥1 entry accepted: `{ "accepted": n, "rejected": [{ "index", "reason" }] }`
- `400` if all entries rejected or the body is malformed.
### `GET /logs`
| Param | Description |
|---|---|
| `service`, `level` | exact match |
| `since`, `until` | time range (inclusive/exclusive) |
| `attr.<key>` | attribute equality |
| `q` | substring match on `message` |
| `limit` | default 100, max 1000 |
| `cursor` | opaque pagination token |
 
Sorted `timestamp DESC, id DESC`. Response: `{ "logs": [...], "next_cursor": string \| null }`. `400` on invalid params.
 
### `GET /logs/aggregate`
Same filters as above, plus `since`, `until`, `bucket` (`1m`/`5m`/`1h`/`1d`) — all required — and optional `group_by` (`service`/`level`).
 
Response: `{ "buckets": [{ "start", "group", "count" }] }`, ordered by `start`, `group: null` when ungrouped.
 
For `bucket=1h` or `1d` with no `q`/`attr.<key>` filter, this is served from the `logs_hourly_counts` rollup table instead of scanning `logs` directly — see Schema and Index Design.
 
## Schema and Index Design
 
`logs` is range-partitioned by day on `ts`:
 
```sql
CREATE TABLE logs (
    id          BIGINT GENERATED ALWAYS AS IDENTITY,
    ts          TIMESTAMPTZ NOT NULL,
    level       log_level NOT NULL,
    service     TEXT NOT NULL,
    message     TEXT NOT NULL,
    attributes  JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);
 
CREATE INDEX idx_logs_service_ts ON logs (service, ts DESC);
CREATE INDEX idx_logs_level_ts   ON logs (level, ts DESC);
CREATE INDEX idx_logs_attrs      ON logs USING GIN (attributes jsonb_path_ops);
CREATE INDEX idx_logs_message    ON logs USING GIN (message gin_trgm_ops);
```
 
- **Daily partitions** keep per-partition indexes small, enable partition pruning on `since`/`until`, and make retention a cheap `DROP TABLE` instead of a locking `DELETE`.
- **`BIGINT IDENTITY`** instead of `UUID` for the primary key — avoids B-tree bloat from random insert order under high write rates.
- **`(id, ts)` composite primary key** — required by Postgres for partitioned tables (the partition key must be part of the key).
- **`(service, ts DESC)` / `(level, ts DESC)`** match the actual filter-then-sort query pattern.
- **Keyset pagination** on `(ts, id)` instead of `OFFSET` — constant time regardless of page depth.
- The table is created via a raw SQL migration (`0000_init.sql`), not `drizzle-kit`, since Drizzle cannot express partitioning. Drizzle's schema is used only for typed reads/writes.
### Hourly rollup table (`0001_rollup.sql`)
 
```sql
CREATE TABLE logs_hourly_counts (
    hour     TIMESTAMPTZ NOT NULL,
    service  TEXT NOT NULL,
    level    log_level NOT NULL,
    count    BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (hour, service, level)
);
```
 
**Why this exists:** under sustained concurrent write load, the actively-written ("today") partition grows continuously *while* aggregate queries are trying to scan it. Every `POST /logs` call upserts matching rows in `logs_hourly_counts` (`hour, service, level → count`) in the same request, via a single batched `UNNEST` + `ON CONFLICT DO UPDATE`. `GET /logs/aggregate` reads this small table instead of `logs` whenever `bucket` is `1h` or `1d` and no `q=`/`attr.<key>` filter is present — cost becomes proportional to the number of hours in range, not the number of rows in the partition being written to. Finer buckets (`1m`/`5m`) and any `q=`/`attr.<key>`-filtered aggregate always fall back to scanning `logs` directly, since those can't be pre-computed from a fixed `(hour, service, level)` rollup.
 
**Known trade-off:** the `COPY` insert into `logs` and the rollup upsert are two separate statements, not one transaction — a failure of the second (rare) leaves the rollup undercounted for that batch without affecting `logs` itself. Documented here rather than hidden.
 
## Attribute Storage Strategy
 
`attributes` is `JSONB`, not an EAV table — one row per log entry. `attr.<key>=value` uses `attributes ->> 'key' = 'value'`, backed by a GIN index (`jsonb_path_ops`).
 
## Retention Strategy
 
Hourly job drops partitions older than `RETENTION_DAYS` (default 30) via `DROP TABLE`. No row-level locking, no bloat, no `VACUUM` required. A separate job pre-creates upcoming partitions.
 
## Load Testing
 
```bash
npm run seed             # 1,000,000 rows via COPY, ~18s
npm run load:ingest       # ingestion throughput alone
npm run load:query         # aggregate latency alone
npm run load:combined       # both concurrently — the scenario that matters most
```
 
`load:combined` drives `POST /logs` continuously (30 connections, 500-entry batches) while issuing one `GET /logs/aggregate` request per second, for 30 seconds — matching the brief's requirement to maintain query performance *while ingestion is active*, at the stated rate of one aggregation request per second.
 
## Performance
 
Measured with `deploy.resources.limits` enforced (app: 0.5 CPU/256MB, Postgres: 1 CPU/1GB), against a fresh clone and a clean `docker compose down -v && up --build`, ~1M rows seeded.
 
| Metric | Requirement | Result |
|---|---|---|
| Ingestion throughput | ≥ 15,000 logs/sec | 16,000–24,500 logs/sec (isolated), 19,000–21,500 logs/sec (concurrent with aggregate polling) |
| Aggregate latency **while ingestion is active** | p95 < 1000ms | **p95: 98–197ms** across 5 consecutive runs, p99 mostly 232–399ms (one run: 961ms) — all passing |
| Dataset seed (1M rows) | ~1 month | 18.1s |
| Tests | — | 16/16 passing |
 
### Bottleneck found and fixed: partition growth during concurrent load
 
Before the rollup table existed, `GET /logs/aggregate` scanned `logs` directly. Under sustained concurrent ingestion, the partition being scanned is the *same* partition being written to during the test — so its size (and the query's cost) grew every second the test ran. Measured directly across consecutive 30-second runs on a freshly-seeded dataset: **p95 climbed 1.1s → 1.8s → 2.8s → 3.6s**, run after run, as the partition accumulated ~12,500 rows per run. Confirmed with `EXPLAIN ANALYZE` (one query scanned 9.4M rows across two partitions, 3+ seconds) and `pg_stat_activity` (the query was continuously in `IO / DataFileRead` — genuinely reading data, not blocked on a lock).
 
**Fix:** the `logs_hourly_counts` rollup table (above). After adding it, the same combined ingestion+aggregate test was re-run 5 consecutive times with no reset in between — p95 stayed flat in the 98–197ms range across all 5 runs, instead of climbing. Re-verified again from a completely fresh `git clone` and clean Docker build to rule out any local-environment artifact.
 
### Other tuning applied
 
- Postgres healthcheck + `service_healthy` startup wait condition (prevents a startup race under constrained CPU).
- `jit=off`, `max_parallel_workers_per_gather=0` — no benefit under a single CPU core, pure coordination overhead.
- `synchronous_commit=off` — accepted trade-off for log data (see Known Limitations).
- Tuned `shared_buffers` / `max_wal_size` / checkpoint settings for a 1GB-limited Postgres instance.
- `jsonb_path_ops` on the attributes GIN index — smaller, cheaper to maintain on writes.
- Process-level `uncaughtException`/`unhandledRejection` handlers — under heavy concurrent write load, Postgres can cancel an in-flight `COPY` (`57014 query_canceled`); without a handler this crashed the whole process. Now logged and the process stays up; the affected request alone gets a `500`.
## Known Limitations
 
- The message (`q=`) GIN trigram index is the main constraint on peak ingestion throughput — removing it (tested, not shipped) raised throughput to ~25,000–30,000 logs/sec, but was rejected because it's required for `q=` to avoid a sequential scan on a multi-million-row table. Kept as a deliberate write/read trade-off.
- `synchronous_commit=off` trades a small crash-durability window (loss of the last fraction of a second of acknowledged writes on a hard crash) for write throughput — acceptable for log data, not for transactional data.
- At very high concurrency (1,000 simultaneous connections, beyond what the throughput requirement implies), the single-core Postgres limit saturates and requests fail; the required throughput is met at realistic concurrency (30–50 connections).
- The rollup update and the `logs` write are not in one transaction (see Schema and Index Design) — a rare failure of the rollup upsert alone would undercount that batch in aggregates without affecting `logs` itself or the accepted/rejected response.
- Local measurements vary run-to-run depending on host machine load (shared CPU between containers and host under WSL2); reported numbers reflect multiple consecutive runs, not a single best case.
## Optional Features
 
No optional features (authentication, API keys, multi-tenancy, or rate limiting) are implemented. `docker compose up` with no environment configuration serves all four endpoints unauthenticated, with no rate limits or quotas.
 