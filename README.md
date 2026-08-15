# Log Ingestion and Query Service

High-throughput service for ingesting, storing, querying, and aggregating structured logs on PostgreSQL.

Built to sustain **15,000+ logs/sec** under constrained Docker resources while keeping aggregate queries responsive during active ingestion.

**Stack:** TypeScript · Express · PostgreSQL · Docker

---

## Performance at a Glance

| Metric | Latest Local Result |
|---|---:|
| Sustained ingestion target | **15,000 logs/sec** |
| Realistic open-loop ingestion | **15,033–15,062 logs/sec** |
| Combined ingestion (with aggregate polling) | **~46,000–48,000 logs/sec** |
| Aggregate p95 during ingestion | **148 ms** |
| Aggregate p99 during ingestion | **217 ms** |
| Aggregate failures during combined test | **0** |
| HTTP errors during realistic test | **0** |
| Eventual query visibility | **100%, within 0.1s** |

Benchmarks were performed under the project's constrained Docker limits:

```text
Application:  0.5 CPU / 256 MB
PostgreSQL:   1 CPU / 1 GB
```

> Official results from the company load generator will be added here after the next submission.

### Highlights

- High-throughput batch ingestion using PostgreSQL `COPY`, buffered and flushed on a short interval with bounded concurrent flushes
- Per-entry validation with partial batch success
- Cursor-based (keyset) pagination on `(ts, id)`
- Daily range partitioning with automatic retention via `DROP TABLE`
- Pre-aggregated **minute-level** rollup table backing every bucket size (`1m`/`5m`/`1h`/`1d`)
- Free-form JSONB attribute filtering
- Case-insensitive message substring search, backed by a trigram index built immediately on every partition (including the active one)
- Dedicated PostgreSQL connection pools for ingest writes, reads, and rollup upserts
- Short-TTL in-memory cache for `GET /logs/aggregate`
- Load-test suite covering ingestion, querying, combined workloads, realistic open-loop traffic, and stress scenarios
- Eventual-consistency verification after sustained ingestion

---

## Architecture

```text
                         ┌─────────────────────┐
                         │      HTTP API        │
                         │      Express          │
                         └──────────┬────────────┘
                                    │
                    ┌───────────────┼────────────────┐
                    │               │                │
                    ▼               ▼                ▼
              Ingestion          Queries          Aggregation
                    │               │                │
                    ▼               ▼                ▼
              Write Pool        Read Pool       Rollup Pool
              (COPY, max 10)   (max 15)         (max 4)
                    │               │                │
                    └───────────────┼────────────────┘
                                    ▼
                              PostgreSQL
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
              ▼                     ▼                     ▼
        Daily log partitions   Minute rollups       Query indexes
```

Three separate PostgreSQL client pools prevent the heaviest workload (ingestion `COPY`) from starving reads and rollup upserts of connections under load.

---

## Quick Start

### Requirements

- Docker
- Docker Compose
- Node.js 24+ for running scripts and tests directly

### Run

```bash
git clone https://github.com/Nour-Anwar/log-ingestion-service.git
cd log-ingestion-service
docker compose up --build
```

**Services:**

- API: `http://localhost:8080`
- PostgreSQL: `localhost:5433`
- Migrations and partition initialization run automatically on startup
- Ready when `GET /health` returns `200`

> Always use `docker compose up --build` after pulling new code — reusing a stale local image runs outdated code even though the source is up to date.

---

## API Documentation

### `GET /health`

Returns `200` once PostgreSQL is reachable, migrations have been applied, and the service is ready to accept traffic. The HTTP server does not start listening until all of this has completed, so a `200` here is a genuine readiness signal, not just a liveness check.

### `POST /logs`

Ingest a batch of structured logs.

**Request body**

```json
{
  "logs": [
    {
      "timestamp": "2026-08-01T12:00:00.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": {
        "user_id": "42",
        "region": "eu-west",
        "retries": 3
      }
    }
  ]
}
```

**Validation** — each entry is validated independently; invalid entries do not invalidate the batch.

| Field | Rule |
|---|---|
| `timestamp` | Required, valid ISO 8601, no more than 5 minutes in the future |
| `level` | `debug`, `info`, `warn`, or `error` |
| `service` | Required, non-empty string |
| `message` | Required, non-empty string |
| `attributes` | Optional flat object; values are string/number/boolean |

**Response**

- `200` if at least one entry is accepted:

```json
{
  "accepted": 9,
  "rejected": [
    { "index": 3, "reason": "invalid level: 'critical'" }
  ]
}
```

- `400` if every entry is rejected, or the body is malformed / doesn't match the expected shape.

### `GET /logs`

Query stored logs with freely combinable filters.

| Parameter | Description | Example |
|---|---|---|
| `service` | Exact service match | `service=checkout` |
| `level` | Exact level match | `level=error` |
| `since` | Inclusive start of time range | `since=2026-08-01T14:00:00Z` |
| `until` | Exclusive end of time range | `until=2026-08-01T15:00:00Z` |
| `attr.<key>` | Attribute equality (compared as strings) | `attr.user_id=42` |
| `q` | Case-insensitive substring match on `message` | `q=declined` |
| `limit` | Default 100, max 1000 | `limit=500` |
| `cursor` | Opaque keyset pagination token | `cursor=eyJpZCI6...` |

Results are ordered by `timestamp DESC, id DESC` (deterministic even with duplicate timestamps).

**Response**

```json
{
  "logs": [
    {
      "id": "123",
      "timestamp": "2026-08-01T14:32:01.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": { "user_id": "42" }
    }
  ],
  "next_cursor": "eyJpZCI6..." 
}
```

`next_cursor` is `null` when there are no further results. Invalid parameters return `400` with `{ "error": "<description>" }`.

### `GET /logs/aggregate`

Time-bucketed log counts. Supports the same filters as `GET /logs`, plus:

| Parameter | Required | Description | Example |
|---|---|---|---|
| `since` | Yes | Inclusive start of the aggregation range | `since=2026-08-01T14:00:00Z` |
| `until` | Yes | Exclusive end of the aggregation range | `until=2026-08-01T15:00:00Z` |
| `bucket` | Yes | `1m`, `5m`, `1h`, or `1d` | `bucket=1m` |
| `group_by` | No | `service` or `level` | `group_by=service` |

**Response**

```json
{
  "buckets": [
    { "start": "2026-08-01T14:00:00Z", "group": "checkout", "count": 118 }
  ]
}
```

Ordered by bucket start ascending. `group` is `null` when `group_by` is omitted. Invalid parameters return `400` in the same format as `GET /logs`.

**Every bucket size is served from the rollup table** (see below) whenever no `q=` or `attr.<key>` filter is present — not just `1h`/`1d`. Queries with `q=`/`attr.<key>` always fall back to a live scan against `logs`, since those fields aren't part of the rollup.

---

## Schema and Index Design

### `logs` table

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
```

- **Daily range partitions** on `ts` — bound index size per partition, enable partition pruning on `since`/`until`, and turn retention into a metadata-only `DROP TABLE` instead of a locking `DELETE`.
- **`BIGINT IDENTITY`** instead of UUID for the primary key — avoids B-tree bloat from random insert order under high write rates.
- **`(id, ts)` composite primary key** — PostgreSQL requires the partition key to be part of any unique constraint on a partitioned table.
- The table is created via a raw SQL migration (`0000_init.sql`), since partitioning syntax isn't expressible through the schema layer used for typed reads/writes.

### Indexes on `logs`

| Index | Purpose |
|---|---|
| `(service, ts DESC, id DESC)` | service-scoped queries, keyset-ready |
| `(level, ts DESC)` | level-scoped queries |
| `(ts DESC, id DESC)` | default keyset pagination order |
| `(service, level, ts DESC)` | combined service+level filters |
| GIN trigram on `message` | substring search (`q=`) |

**`idx_logs_attrs` (GIN, `jsonb_path_ops`) was removed** (`0005_drop_attrs_gin.sql`). `attr.<key>=value` filtering compares JSON values as text via `attributes ->> 'key' = 'value'`, and `jsonb_path_ops` only accelerates containment (`@>`) queries — it provided zero benefit for the query pattern actually used, while adding GIN-maintenance cost to every insert. Removed as a pure write-cost reduction. If attribute-filter read latency becomes a measured bottleneck, a targeted expression index on specific hot keys (e.g. `(attributes ->> 'user_id')`) is the next step, chosen from `pg_stat_user_indexes` data rather than guessing.

**The message trigram index is built immediately on every partition, including the currently-active one** — not deferred until a partition is "sealed." Deferring it means any `q=` search during the exact window a load test runs falls back to a full sequential scan on the partition receiving all the write traffic. Building it eagerly (on an empty, freshly-created partition) costs write overhead as the partition fills, but keeps `q=` search usable throughout.

### Minute-level rollup table

```sql
CREATE TABLE logs_minute_counts (
    minute   TIMESTAMPTZ NOT NULL,
    service  TEXT NOT NULL,
    level    log_level NOT NULL,
    count    BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (minute, service, level)
);
-- UNLOGGED: derived data, rebuildable from `logs`, no WAL overhead
```

**Why minute-level, not hourly:** an earlier version of this table stored hourly counts. That only accelerated `bucket=1h`/`1d` requests — any `bucket=1m` or `5m` request (arguably the more realistic "live dashboard" case) always fell back to a full live scan of `logs`, since an hourly count can't be split back into minutes. Replacing it with a single minute-granularity table means **every** bucket size (`1m`/`5m`/`1h`/`1d`) is served from the same rollup via `date_bin`, with no code path that's structurally forced into a full-table scan.

Updated on every ingest batch via a single batched `UNNEST(...) ... ON CONFLICT (...) DO UPDATE`, through a dedicated connection pool (see below) so it never competes with `COPY` streams for write-pool connections.

**Boundary correctness:** a rollup row represents a full minute. A query's `since`/`until` will usually fall in the middle of a minute, not on a clean boundary. `runAggregate()` therefore splits the requested range into: any partial leading minute (live query against `logs`), the fully-covered middle minutes (rollup), any partial trailing minute before the safety margin (live query), and a fixed safety-margin tail — the most recent few seconds, which the rollup hasn't caught up to yet (live query). All of these sub-queries run in parallel via `Promise.all`, not sequentially, which is what keeps aggregate p95 low even while every request touches multiple sources. Comparing `since`/`until` directly against `minute` without this splitting silently drops or double-counts the partial-minute edges — this was found and fixed during load testing (see Known Limitations / testing notes below for how it was diagnosed).

### Aggregate cache

`GET /logs/aggregate` responses are cached in-process for a short TTL (200ms, capped at 100 entries), keyed by the full parsed query. This smooths repeated identical aggregate polling (e.g. the "one aggregation request per second" requirement) without risking staleness beyond the eventual-consistency window.

### Attribute Storage

`attributes` is a single JSONB column — one row per log entry, not an EAV table. Only flat objects with string/number/boolean values are accepted on ingest. Filtering uses `attributes ->> 'key' = 'value'` (string comparison, matching the spec's "compared as strings" requirement).

### Retention Strategy

A periodic job drops partitions older than `RETENTION_DAYS` (default 30) via `DROP TABLE` — no row-level locking, no bloat, no `VACUUM` required. A separate job pre-creates upcoming partitions (and builds their trigram index immediately, as above).

---

## Connection Pools

| Pool | Used for | Max connections |
|---|---|---|
| Write (`sql`) | `COPY` ingestion | 10 |
| Read (`readSql`) | `GET /logs`, `GET /logs/aggregate` | 15 |
| Rollup (`rollupSql`) | minute-rollup upserts | 4 |

Splitting these out prevents the rollup's periodic batched upserts from queuing behind long-held `COPY` stream connections during heavy ingestion — and vice versa.

---

## Load Testing

```bash
npm run seed          # bulk row generation via COPY
npm run load:ingest      # ingestion throughput alone
npm run load:query        # query/aggregate latency alone
npm run load:combined      # ingestion + aggregate polling, concurrently
npm run load:realistic      # open-loop 15k logs/s for 120s + eventual-consistency check
npm run load:stress          # ramping/stress profile
```

`load:combined` drives `POST /logs` continuously while issuing one `GET /logs/aggregate` request per second — the scenario the spec calls out explicitly ("maintain query performance while ingestion is active", "one aggregation request per second").

`load:realistic` sends open-loop traffic (not waiting for each request to complete before sending the next) at the target rate, then polls `GET /logs/aggregate` after the load phase to confirm every accepted log becomes queryable — verifying the "queryable within 20 seconds" requirement directly rather than assuming it.

All numbers in this README were measured with Docker resource limits actually enforced (`cpus:` / `mem_limit:`, not `deploy.resources.limits`, which some Compose versions apply inconsistently outside Swarm mode) — see `docker-compose.yml`.

---

## Design Decisions & Trade-offs

**PostgreSQL `COPY`, buffered.** Ingested rows are batched into an in-memory buffer and flushed via `COPY ... FROM STDIN`, with a bounded number of concurrent flushes, rather than one `INSERT` per request. This is the dominant lever for meeting the 15k logs/sec target under a single Postgres CPU core.

**Keyset pagination on `(ts, id)`**, not `OFFSET` — constant-time regardless of page depth.

**`synchronous_commit=off`** on the ingest connection — accepted trade-off for log data: a small window of just-acknowledged writes could be lost on a hard crash, in exchange for materially higher sustained throughput. Not an acceptable trade-off for transactional data, but reasonable here.

**`full_page_writes=on`** (kept on, not disabled) — protects against torn pages on an unclean shutdown (e.g. an OOM kill under memory pressure). The throughput cost is small relative to the risk of on-disk corruption after a crash, which was judged not worth trading away.

**`jit=off`, `max_parallel_workers=0`** — no benefit under a single CPU core; pure coordination overhead that a constrained single-core Postgres instance doesn't need.

**Minute-granularity rollup over hourly** — see "Minute-level rollup table" above.

**Separate connection pools per workload** — see "Connection Pools" above.

---

## Known Limitations

- The message trigram index has a measurable ingestion cost, and is kept deliberately because `q=` search would otherwise force a sequential scan on a multi-million-row table.
- `synchronous_commit=off` trades a small crash-durability window for higher write throughput; not suitable for non-log, transactional workloads.
- The rollup upsert and the `logs` `COPY` are two separate statements, not one transaction. A rare failure of the rollup upsert alone would leave that batch undercounted in aggregates without affecting `logs` itself or the ingest response.
- At very high concurrency (hundreds to 1,000+ simultaneous connections, beyond what the throughput requirement implies), the single-core Postgres limit saturates; the required throughput is met at realistic concurrency (tens of connections).
- Local benchmark numbers vary run-to-run depending on host machine load (containers sharing CPU with the host under WSL2); reported figures reflect multiple consecutive runs, not a single best case.
- `attr.<key>` filters currently rely on a sequential scan when not combined with a `service`/time-range filter that narrows the row set first, since the previous GIN index on `attributes` was measured to provide no benefit to the actual query pattern and was removed. Revisit with a targeted expression index if `pg_stat_user_indexes` data shows it's needed.

---

## Optional Features

No optional features (authentication, API keys, multi-tenancy, or rate limiting) are implemented. A plain `docker compose up` with no environment configuration serves all four required endpoints unauthenticated, with no rate limits or quotas — this is also the configuration all numbers in this README were measured under.

---

## Testing

```bash
npm test
```

Covers health/readiness, ingestion validation and partial-batch success, query filtering, cursor pagination, aggregation (including grouping and the empty-`group_by` case), using a real PostgreSQL instance rather than mocked database access.

---

## Project Structure

```text
.
├── Dockerfile
├── README.md
├── docker-compose.yml
├── drizzle.config.ts
├── package-lock.json
├── package.json
├── scripts
│   ├── load-test-combined.ts
│   ├── load-test-ingest.ts
│   ├── load-test-query.ts
│   ├── load-test-realistic.ts
│   ├── load-test-stress.ts
│   └── seed.ts
├── src
│   ├── app.ts
│   ├── db
│   │   ├── client.ts
│   │   ├── messageIndex.ts
│   │   ├── migrations
│   │   │   ├── 0000_init.sql
│   │   │   ├── 0001_rollup.sql
│   │   │   ├── 0002_ts_index.sql
│   │   │   ├── 0003_aggregate_indexes.sql
│   │   │   ├── 0004_minute_rollup.sql
│   │   │   └── 0005_drop_attrs_gin.sql
│   │   ├── partitions.ts
│   │   ├── rollup.ts
│   │   ├── runMigrations.ts
│   │   ├── schema.ts
│   │   └── writeBuffer.ts
│   ├── logs
│   │   ├── aggregate.ts
│   │   ├── aggregateCache.ts
│   │   ├── aggregateValidate.ts
│   │   ├── ingest.ts
│   │   ├── list.ts
│   │   ├── query.ts
│   │   ├── queryValidate.ts
│   │   └── validate.ts
│   └── server.ts
├── tests
│   ├── aggregate.test.ts
│   ├── globalSetup.ts
│   ├── health.test.ts
│   ├── helpers.ts
│   ├── ingest.test.ts
│   └── query.test.ts
├── tsconfig.json
└── vitest.config.ts
```

---

## License

MIT