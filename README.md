# Log Ingestion and Query Service

High-throughput service for ingesting, storing, querying, and aggregating structured logs on PostgreSQL.

Built to sustain **15,000+ logs/sec** under constrained Docker resources (0.5 CPU / 256 MB app, 1 CPU / 1 GB PostgreSQL) while keeping aggregate queries fast during active ingestion.

**Stack:** TypeScript · Express · PostgreSQL · Docker

---

## Official Load Generator Results

Measured by the company's own load generator (`@foothill/logs-benchmark`), against the actual resource-limited containers.

| Category | Score | Notes |
|---|---:|---|
| **Overall** | **97.30 / 100** | |
| Correctness | 15 / 15 (100%) | All 15 required-contract checks passed |
| Performance | 47.50 / 50 (95.0%) | Throughput, error rate, latency, sustained-load bonus |
| Queries | 14.80 / 15 (98.7%) | Aggregate latency + eventual-consistency checks |
| Reliability | 20 / 20 (100%) | All scenarios completed, zero crashes |

### Scenario breakdown

| Scenario | Ingest rate | p95 ingest latency | Aggregate p95 | Error rate | Rows accepted |
|---|---:|---:|---:|---:|---:|
| Load | 14,999 logs/s | 40.5 ms | 11 ms | 0% | 1,799,900 |
| Stress | 20,999 logs/s | 42.4 ms | 96 ms | 0% | 3,149,900 |
| Spike | 15,374 logs/s | 42.8 ms | 87 ms | 0% | 1,537,400 |
| Breakpoint | 24,373 logs/s | 49.5 ms | 62 ms | 0% | 2,924,800 |

All four scenarios completed with **zero errors and zero crashes**, sustaining above the 15,000 logs/sec baseline target in every case, and above 20,000 logs/sec in three of the four.

### A note on `readAfterWriteSuccessRate`

Each scenario also reports a `readAfterWriteSuccessRate` between 0.13 and 0.20 — the fraction of logs that are visible in `GET /logs/aggregate` **immediately** after being written, with no wait. This is expected and by design, not a bug: the write path buffers and flushes every 30 ms, and the minute-level rollup (which back most aggregate queries) flushes on a separate 500 ms cycle with an additional 1.5 s safety margin before it's trusted (see [Minute-level rollup table](#minute-level-rollup-table)). A log accepted this millisecond is not expected to be aggregate-visible this millisecond.

What the spec actually requires is that new data be **queryable within 20 seconds** — a much looser bound. That's measured separately as eventual consistency, which **passed all 4/4 scenarios** and is scored at its maximum (6/6 points) inside the Queries category. The low `readAfterWriteSuccessRate` numbers did not cost points beyond the small headroom already visible in the 98.7% Queries score.

---

## Architecture

```text
                         ┌─────────────────────┐
                         │      HTTP API         │
                         │      Express           │
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

Three separate PostgreSQL connection pools (`sql`, `readSql`, `rollupSql` in `src/db/client.ts`) keep the heaviest workload (ingestion `COPY`) from starving reads and rollup upserts of connections under load.

---

## Quick Start

### Requirements

- Docker
- Docker Compose

### Run

```bash
git clone https://github.com/Nour-Anwar/log-ingestion-service.git
cd log-ingestion-service
docker compose up --build
```

**Services:**

- API: `http://localhost:8080`
- PostgreSQL: `localhost:5433` (host-mapped; the app talks to `postgres:5432` internally)
- Migrations and partition initialization run automatically on startup
- Ready when `GET /health` returns `200`

> Use `docker compose up --build` after pulling new code — a stale local image will run outdated code even though the source is current.

---

## API Documentation

### `GET /health`

Returns `200` with `{ "status": "ok" }`. The handler itself does not run a live database check on every request — instead, `src/server.ts` performs `SELECT 1`, runs migrations, and ensures partitions exist **before** calling `app.listen()`. The HTTP server does not start accepting connections until all of that has completed, so a `200` response is a genuine readiness signal by construction, not a per-request check.

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

**Validation** (`src/logs/validate.ts`) — each entry validated independently; an invalid entry never invalidates the whole batch.

| Field | Rule |
|---|---|
| `timestamp` | Required, valid ISO 8601, no more than 5 minutes in the future |
| `level` | `debug`, `info`, `warn`, or `error` |
| `service` | Required, non-empty string |
| `message` | Required, non-empty string |
| `attributes` | Optional flat object; values are string/number/boolean only |

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

- `400` if every entry is rejected, the body isn't `{ logs: [...] }`, or the JSON is malformed.
- `503` with `Retry-After: 1` if the internal ingestion queue is full (backpressure — see [Write buffer](#write-buffer-and-ingestion-pipeline)). This is additive backpressure handling, not part of the required contract's status codes.

### `GET /logs`

Query stored logs with freely combinable filters.

| Parameter | Description | Example |
|---|---|---|
| `service` | Exact service match | `service=checkout` |
| `level` | Exact level match | `level=error` |
| `since` | Inclusive start of time range | `since=2026-08-01T14:00:00Z` |
| `until` | Exclusive end of time range | `until=2026-08-01T15:00:00Z` |
| `attr.<key>` | Attribute equality, compared as strings | `attr.user_id=42` |
| `q` | Case-insensitive substring match on `message` | `q=declined` |
| `limit` | Default 100, max 1000 | `limit=500` |
| `cursor` | Opaque keyset pagination token | `cursor=eyJpZCI6...` |

Results are ordered by `ts DESC, id DESC` — deterministic even with duplicate timestamps.

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

Time-bucketed log counts. Supports the same filters as `GET /logs` (`service`, `level`, `attr.<key>`, `q`), plus:

| Parameter | Required | Description | Example |
|---|---|---|---|
| `since` | Yes | Inclusive start of the aggregation range | `since=2026-08-01T14:00:00Z` |
| `until` | Yes | Exclusive end of the aggregation range | `until=2026-08-01T15:00:00Z` |
| `bucket` | Yes | `1m`, `5m`, `1h`, or `1d` | `bucket=1m` |
| `group_by` | No | `service` or `level` | `group_by=service` |

`since === until` is accepted as a valid empty range (returns empty buckets); only `until < since` is rejected.

**Response**

```json
{
  "buckets": [
    { "start": "2026-08-01T14:00:00Z", "group": "checkout", "count": 118 }
  ]
}
```

Ordered by bucket start ascending. `group` is `null` when `group_by` is omitted. Invalid parameters return `400` in the same format as `GET /logs`.

**Responses are cached** in-process for 200 ms per unique parameter combination (see [Aggregate cache](#aggregate-cache)).

---

## Schema and Index Design

### `logs` table (`src/db/migrations/0000_init.sql`)

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

CREATE TABLE logs_default PARTITION OF logs DEFAULT;
```

- **Daily range partitions** on `ts` — bound index size per partition, enable partition pruning on `since`/`until`, and turn retention into a metadata-only `DROP TABLE` instead of a locking `DELETE`.
- **`logs_default`** is a catch-all `DEFAULT` partition for any row whose timestamp falls outside the range of partitions currently maintained by `ensurePartitions()` (1 day back / 3 days forward by default — see below). It is never dropped by retention. In normal operation it should stay empty; see [Known Limitations](#known-limitations).
- **`BIGINT IDENTITY`** instead of UUID for the primary key — avoids B-tree bloat from random insert order under high write rates.
- **`(id, ts)` composite primary key** — PostgreSQL requires the partition key to be part of any unique constraint on a partitioned table.
- Created via a raw SQL migration, since partitioning syntax isn't expressible through Drizzle's typed schema layer (`src/db/schema.ts` mirrors the logical shape for typed reads/writes, but the physical table — partitioning, the `log_level` enum, `pg_trgm` — is owned by the SQL migrations).

### Indexes on `logs` (`0001_core_indexes.sql`)

| Index | Purpose |
|---|---|
| `(ts DESC, id DESC)` | default keyset pagination order, no filter |
| `(service, ts DESC, id DESC)` | `service=` filter, keyset-ready |
| `(level, ts DESC, id DESC)` | `level=` filter, keyset-ready |
| `(service, level, ts DESC)` | combined `service=` + `level=` filters |

There is **no index on `attributes`**. `attr.<key>` filtering compares JSON values as text via `attributes ->> 'key' = 'value'`, matching the spec's "compared as strings" requirement, and currently relies on a sequential scan of whichever partitions the time-range filter (or lack of one) leaves in play. This was a deliberate choice from the start of the project, not a later removal — a GIN index (`jsonb_path_ops`) only accelerates containment (`@>`) queries, and would add write-side maintenance cost to every insert for a query pattern (`->>`) it doesn't help. If attribute-filter read latency becomes a measured bottleneck, a targeted expression index on a specific hot key (e.g. `(attributes ->> 'user_id')`) is the next step — chosen from `pg_stat_user_indexes` data, not guessed in advance.

### Message search index (`src/db/messageIndex.ts`)

```sql
CREATE INDEX CONCURRENTLY idx_<partition>_message_trgm
ON <partition> USING GIN (message gin_trgm_ops)
```

Built per-partition, **but only on partitions strictly older than today** (`partitionDate >= today` is skipped). Today's partition — the one receiving 100% of write traffic during any load test — is deliberately left without a trigram index, so every insert into it avoids GIN-maintenance overhead during the highest-write-pressure window.

**Trade-off this implies:** `q=` (message substring) queries that touch *today's* data fall back to a sequential `ILIKE` scan on the active partition. Queries that only touch prior days use the trigram index and stay fast. `ensureMessageIndexes()` runs at startup and every 6 hours (alongside `ensurePartitions()`), so yesterday's partition gets indexed once it's no longer "today." This is a real limitation, not yet fully mitigated — see [Known Limitations](#known-limitations).

### Minute-level rollup table (`0002_minute_rollup.sql`)

```sql
CREATE TABLE logs_minute_counts (
    minute   TIMESTAMPTZ NOT NULL,
    service  TEXT NOT NULL,
    level    log_level NOT NULL,
    count    BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (minute, service, level)
);
-- UNLOGGED: derived, rebuildable from `logs`, no WAL overhead
```

Minute granularity (not hourly) so that **every** bucket size (`1m`/`5m`/`1h`/`1d`) can be served from the same table via `date_bin` — an hourly rollup can't be split back into minutes, so `bucket=1m`/`5m` requests would always need a live scan.

**How `GET /logs/aggregate` uses it** (`src/logs/aggregate.ts`, `runAggregate()`): the rollup is used only when there's no `q=` or `attr.<key>` filter (neither field exists in the rollup). The requested `[since, until)` range is split into up to four pieces, run **in parallel** via `Promise.all`:

1. Partial leading minute — live query against `logs`
2. Fully-covered whole minutes — served from `logs_minute_counts`
3. Partial trailing minute before the safety margin — live query
4. Safety-margin tail (the most recent **1.5 seconds**, `ROLLUP_SAFETY_MARGIN_MS`) — live query, since the rollup's 500 ms flush cycle may not have caught up yet

Comparing `since`/`until` directly against `minute` without this splitting would silently drop or double-count the partial-minute edges.

### Aggregate cache

`GET /logs/aggregate` responses are cached in-process (`src/logs/aggregateCache.ts`) for **200 ms**, capped at **100 entries**, keyed by the full parsed query. Smooths repeated identical aggregate polling (the spec's "one aggregation request per second" requirement) without risking staleness beyond the eventual-consistency window.

### Attribute storage

`attributes` is a single JSONB column — one row per log entry, not an EAV table. Only flat objects with string/number/boolean values are accepted on ingest (`validate.ts`). Filtering always uses `attributes ->> 'key' = 'value'`.

### Retention strategy (`src/db/partitions.ts`)

A job (`applyRetention`, hourly, `RETENTION_DAYS` default **30**) drops any `logs_YYYY_MM_DD` partition older than the cutoff via `DROP TABLE IF EXISTS` — no row-level locking, no bloat, no `VACUUM` needed. `ensurePartitions()` (startup + every 6 hours) pre-creates partitions from 1 day back to 3 days forward and tunes autovacuum aggressively on each new partition (`autovacuum_vacuum_scale_factor = 0.01`, `cost_delay = 0`) — the default 20%-change threshold is far too high for a partition absorbing millions of rows in minutes, which was confirmed with `EXPLAIN ANALYZE` showing hundreds of thousands of extra heap fetches from a stale visibility map under load.

---

## Write Buffer and Ingestion Pipeline

`src/db/writeBuffer.ts` batches accepted rows in memory and flushes them via `COPY ... FROM STDIN`, rather than one `INSERT` per request:

| Setting | Value |
|---|---|
| Flush interval | 30 ms |
| Max batch size | 20,000 rows |
| Max concurrent flushes | 2 |
| Max queued batches | 8 (≈160,000 rows) |

A batch flushes early if it hits 20,000 rows before the 30 ms timer fires. If the queue is full, `enqueueLogs()` rejects with `BackpressureError`, which `ingest.ts` turns into `503` + `Retry-After: 1` — shedding load explicitly rather than accepting a request the service can't durably honor. After each successful `COPY`, the batch's accepted entries are handed to `queueRollupCounts()` (`src/db/rollup.ts`), which merges them by `(minute, service, level)` in memory and flushes to `logs_minute_counts` every 500 ms via a single batched `UNNEST(...) ON CONFLICT DO UPDATE`.

---

## Connection Pools (`src/db/client.ts`)

| Pool | Used for | Max connections | Notes |
|---|---|---:|---|
| `sql` | `COPY` ingestion | 10 | `synchronous_commit = off` |
| `readSql` | `GET /logs`, `GET /logs/aggregate` | 15 | |
| `rollupSql` | minute-rollup upserts | 4 | `synchronous_commit = off` |

Splitting these prevents the rollup's periodic batched upserts from queuing behind long-held `COPY` stream connections during heavy ingestion, and vice versa.

---

## Design Decisions & Trade-offs

**PostgreSQL `COPY`, buffered in-process.** The dominant lever for meeting the 15k logs/sec target under a single Postgres CPU core — see [Write Buffer](#write-buffer-and-ingestion-pipeline).

**Keyset pagination on `(ts, id)`**, not `OFFSET` — constant-time regardless of page depth.

**`synchronous_commit = off`** on the ingest and rollup pools — accepted trade-off for log data: a small window of just-acknowledged writes could be lost on a hard crash, in exchange for materially higher sustained throughput. Not an acceptable trade-off for transactional data, but reasonable here.

**`full_page_writes` left at its default (on)** in `docker-compose.yml` — protects against torn pages on an unclean shutdown (e.g. an OOM kill under the 256 MB app / 1 GB Postgres memory limits). The throughput cost is small relative to the risk of on-disk corruption after a crash.

**`jit=off`, `max_parallel_workers=0`** — no benefit under a single CPU core; pure coordination overhead a constrained single-core Postgres instance doesn't need.

**Message trigram index skipped on the active partition** — see [Message search index](#message-search-index-srcdbmessageindexts). Trades `q=` latency on today's data for lower insert overhead during the highest-pressure write window.

**MATERIALIZED CTE for attribute-filtered queries** (`query.ts`): when `attr.<key>` filters are present, the query is wrapped in `WITH matches AS MATERIALIZED (...)`. Without it, the planner's natural per-partition `Merge Append` plan applies the `ORDER BY`/`LIMIT` to each partition before filtering, doing redundant partial sorts across many partitions before the rare attribute match is found. Materializing forces filter-then-sort-once over the combined result.

**Rollup upsert and `logs` `COPY` are two separate statements**, not one transaction — see [Known Limitations](#known-limitations).

---

## Known Limitations

- **`q=` search on today's partition falls back to a sequential scan** — the trigram index is only built on partitions older than the current day, to avoid GIN-maintenance cost during peak write pressure (see [Message search index](#message-search-index-srcdbmessageindexts)). Message search against the most recent data is the slowest query path in the system.
- **`attr.<key>` filtering has no supporting index** and relies on a sequential scan (mitigated somewhat by the `MATERIALIZED` CTE and by `service`/time-range filters narrowing the partition set first). A targeted expression index on a specific hot key is the next step if this proves to be a real bottleneck.
- **The rollup upsert and the `logs` `COPY` are not transactional together.** A rare failure of the rollup upsert alone (it retries in-memory on failure — see `rollup.ts`'s `catch` block, which re-merges the failed batch back into `pending`) could, in the worst case of a crash between failure and retry, leave that batch undercounted in aggregate results without affecting `logs` itself or the ingest response the client already received.
- **`logs_default` (the catch-all partition) is never retention-swept** and has no dedicated index beyond what it inherits. It should stay empty in normal operation (writes always fall within the ±1/+3-day window `ensurePartitions()` maintains), but a client sending far-future or far-past timestamps outside that window — and within the 5-minute-future validation limit, so still valid — would land there.
- **`synchronous_commit = off`** trades a small crash-durability window for higher write throughput; not suitable for non-log, transactional workloads.
- Read-after-write is not immediate (typically visible within hundreds of milliseconds to ~2 seconds depending on rollup/cache timing), only guaranteed within the spec's 20-second eventual-consistency window. See [A note on `readAfterWriteSuccessRate`](#a-note-on-readafterwritesuccessrate).
- The `POST /logs` `503`/`Retry-After` backpressure response is additive (not part of the four core response shapes) and only appears once the in-memory write queue is saturated (~160,000 queued rows) — not observed during the official benchmark runs (0% error rate across all four scenarios).

---

## Optional Features

**None implemented.** No authentication, API keys, multi-tenancy, or rate limiting. A plain `docker compose up` with no environment configuration serves all four required endpoints unauthenticated, with no rate limits or quotas — this is also the only configuration the service supports, and the one all benchmark numbers above were measured under.

`RETENTION_DAYS` (default `30`) is the one environment variable that affects behavior; it is not gated behind any feature flag.

---

## Testing

```bash
npm test
```

Runs against a real PostgreSQL instance (not mocked). Covers `/health`, ingestion validation and partial-batch acceptance, query filtering, cursor pagination, and aggregation (including grouping and the omitted-`group_by` case).

## Load Testing

```bash
npm run seed          # bulk row generation via COPY
npm run load:ingest      # ingestion throughput alone
npm run load:query        # query/aggregate latency alone
npm run load:combined      # ingestion + aggregate polling, concurrently
npm run load:realistic      # open-loop target-rate traffic + eventual-consistency check
npm run load:stress          # ramping/stress profile
```

The numbers in [Official Load Generator Results](#official-load-generator-results) above come from the company's own load generator (`https://loadgen.foothilltech.net/`), run against the actual resource-limited containers (`cpus:` / `mem_limit:` in `docker-compose.yml`).

---

## Project Structure

```text
.
├── Dockerfile
├── README.md
├── docker-compose.yml
├── drizzle.config.ts
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
│   ├── server.ts
│   ├── db
│   │   ├── client.ts
│   │   ├── messageIndex.ts
│   │   ├── partitions.ts
│   │   ├── rollup.ts
│   │   ├── runMigrations.ts
│   │   ├── schema.ts
│   │   ├── writeBuffer.ts
│   │   └── migrations
│   │       ├── 0000_init.sql
│   │       ├── 0001_core_indexes.sql
│   │       └── 0002_minute_rollup.sql
│   └── logs
│       ├── aggregate.ts
│       ├── aggregateCache.ts
│       ├── aggregateValidate.ts
│       ├── ingest.ts
│       ├── list.ts
│       ├── query.ts
│       ├── queryValidate.ts
│       └── validate.ts
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