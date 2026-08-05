# Log Ingestion and Query Service
 
Service for ingesting, querying, and aggregating structured logs at scale.
 
**Built with:** TypeScript · Express · PostgreSQL · Drizzle ORM · Docker
 
## Features
 
- High-throughput batch log ingestion via `COPY`
- Cursor-based (keyset) pagination
- Daily PostgreSQL partitioning with automatic retention
- Time-bucketed aggregation with grouping
- Free-form JSONB attribute filtering
- Bulk dataset seeding for load testing
## Quick Start
 
```bash
git clone https://github.com/Nour-Anwar/log-ingestion-service
cd log-ingestion-service
docker compose up --build
```
 
- API: `http://localhost:8080`
- Postgres: `localhost:5433`
- Migrations run automatically on startup; readiness is signaled via `GET /health`.
## Project Structure
 
```
src/
  app.ts              # Express app, route wiring
  server.ts           # startup: migrations, partitions, listen
  db/
    client.ts         # postgres connection pool
    schema.ts         # Drizzle schema (typed reads only)
    runMigrations.ts  # applies 0000_init.sql on startup
    partitions.ts     # partition creation + retention
    migrations/       # raw SQL, source of truth for schema
  logs/
    ingest.ts          # POST /logs
    list.ts             # GET /logs
    aggregate.ts        # GET /logs/aggregate
    validate.ts, queryValidate.ts, aggregateValidate.ts
scripts/
  seed.ts              # bulk data generation
  load-test-ingest.ts  # ingestion throughput test
  load-test-query.ts   # aggregate latency test
tests/                 # vitest + supertest
.github/workflows/     # CI pipeline
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
 
## Schema
 
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
 
- Range-partitioned daily on `ts` — bounds index size per partition, enables partition pruning, makes retention a `DROP TABLE`.
- `BIGINT IDENTITY` PK (not UUID) — avoids B-tree bloat from random insert order.
- `(id, ts)` composite PK — required by Postgres for partitioned tables.
- Keyset pagination on `(ts, id)` — constant time regardless of page depth; no `OFFSET`.
- Table is created via raw SQL migration (`src/db/migrations/0000_init.sql`); Drizzle is used for typed queries only, not schema creation (it can't express partitioning).
## Attribute Storage
 
`attributes` is `JSONB`, not an EAV table — one row per log entry. `attr.<key>=value` uses `attributes ->> 'key' = 'value'`, backed by a GIN index (`jsonb_path_ops`).
 
## Retention
 
Hourly job drops partitions older than `RETENTION_DAYS` (default 30) via `DROP TABLE`. No row-level locking, no bloat, no `VACUUM` required. A separate job pre-creates upcoming partitions.
 
## Testing
 
```bash
docker compose up -d postgres
npm test
```
 
16 tests covering ingestion validation, query filtering, cursor pagination, and aggregation grouping — run against a real Postgres instance.
 
## Load Testing
 
```bash
npm run seed          # 1,000,000 rows via COPY, ~18s
npm run load:ingest    # sustained ingestion throughput
npm run load:query     # aggregate latency under load
```
 
`load:ingest`: 50 connections, 500-entry batches, 30s, via `autocannon`.
 
## Performance
 
Benchmarks were measured under the assignment's required Docker resource limits (app: 0.5 CPU/256MB, Postgres: 1 CPU/1GB), with ~1M rows seeded.
 
| Metric | Requirement | Result |
|---|---|---|
| Ingestion throughput | ≥ 15,000 logs/sec | 16,000–24,500 logs/sec (multiple runs), 0 errors/timeouts |
| Aggregate latency under load | p95 < 1000ms | p99 ≈ 325–730ms |
| Dataset seed (1M rows) | ~1 month | 18.1s |
| Tests | — | 16/16 passing |
 
**Bottleneck:** under load, Postgres runs at 100% CPU while the app stays ~30% — GIN index maintenance during writes is the limiting factor, confirmed by isolating the trigram index on `message` (removing it raised throughput to ~25,000–30,000 logs/sec). The index is retained because `q=` requires it to avoid a sequential scan; kept as a deliberate write/read trade-off.
 
**Tuning applied:** Postgres healthcheck + startup wait condition; `jit=off`, `max_parallel_workers_per_gather=0` (no benefit under 1 core); `synchronous_commit=off`; tuned `shared_buffers`/`max_wal_size`/checkpoint settings; single buffered write per ingest batch; `jsonb_path_ops` on the attributes index.
 
## Known Limitations
 
- At very high concurrency (1,000 simultaneous connections), the single-core Postgres limit saturates — throughput degrades and requests may time out. The required throughput is met at realistic concurrency (50 connections).
- Local measurements vary ±30% run-to-run (shared CPU between containers and host under WSL2); reported numbers reflect multiple runs, not a single best case.
## License
 
MIT
 