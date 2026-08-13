# Log Ingestion and Query Service

High-throughput service for ingesting, storing, querying, and aggregating structured logs.

**Stack:** TypeScript · Express · PostgreSQL · Drizzle ORM · Docker

## Features

- High-throughput batch ingestion using PostgreSQL `COPY`
- Per-entry validation with partial success
- Cursor-based (keyset) pagination
- Daily range partitioning with automatic retention
- Pre-aggregated hourly rollup for fast aggregation under load
- Free-form JSONB attribute filtering
- Case-insensitive message substring search

## Quick Start

```bash
git clone https://github.com/Nour-Anwar/log-ingestion-service
cd log-ingestion-service
docker compose up --build
```

- API: `http://localhost:8080`
- PostgreSQL: `localhost:5433`
- Migrations run automatically on startup
- Ready when `GET /health` returns `200`

> Always use `--build` after pulling new code.

## Project Structure

```
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
│   │   │   ├── 0004_unlogged_rollup.sql
│   │   │   └── 0005_drop_level_index.sql
│   │   ├── partitions.ts
│   │   ├── rollup.ts
│   │   ├── runMigrations.ts
│   │   ├── schema.ts
│   │   └── writeBuffer.ts
│   ├── logs
│   │   ├── aggregate.ts
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

## API Documentation

### `GET /health`

Returns `200` once the database is connected, migrations are applied, and the service is ready.

### `POST /logs`

Ingest a batch of structured logs.

**Request body**
```json
{
  "logs": [
    {
      "timestamp": "2026-07-20T14:32:01.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": {
        "user_id": "42",
        "region": "eu-west"
      }
    }
  ]
}
```

**Validation rules**
- `timestamp` — required, valid ISO 8601, ≤ 5 minutes in the future
- `level` — required, one of `debug` | `info` | `warn` | `error`
- `service` — required, non-empty string
- `message` — required, non-empty string
- `attributes` — optional, flat object (string / number / boolean only)

Invalid entries are rejected individually; valid ones are accepted.

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
- `400` if all entries are rejected or the body is malformed

### `GET /logs`

Query logs with freely combinable filters.

| Parameter    | Description                           | Example                     |
|--------------|---------------------------------------|-----------------------------|
| `service`    | Exact service match                   | `service=checkout`          |
| `level`      | Exact level match                     | `level=error`               |
| `since`      | Inclusive start of time range         | `since=2026-07-20T14:00:00Z`|
| `until`      | Exclusive end of time range           | `until=2026-07-20T15:00:00Z`|
| `attr.<key>` | Attribute equality                    | `attr.user_id=42`           |
| `q`          | Case-insensitive substring on message | `q=declined`                |
| `limit`      | Max results (default 100, max 1000)   | `limit=500`                 |
| `cursor`     | Opaque cursor                         | `cursor=eyJpZCI6...`        |

Results sorted by `timestamp DESC, id DESC`.

**Response**
```json
{
  "logs": [ ... ],
  "next_cursor": "eyJpZCI6..." | null
}
```

Invalid parameters return `400` with `{ "error": "<description>" }`.

### `GET /logs/aggregate`

Time-bucketed aggregation.

Supports the same filters as `GET /logs` plus:

| Parameter  | Required | Description                    | Example                |
|------------|----------|--------------------------------|------------------------|
| `since`    | Yes      | Inclusive start                | `since=2026-07-20T14:00:00Z` |
| `until`    | Yes      | Exclusive end                  | `until=2026-07-20T15:00:00Z` |
| `bucket`   | Yes      | `1m` \| `5m` \| `1h` \| `1d`  | `bucket=1h`            |
| `group_by` | No       | `service` or `level`           | `group_by=service`     |

**Response**
```json
{
  "buckets": [
    { "start": "2026-07-20T14:00:00Z", "group": "checkout", "count": 118 }
  ]
}
```

- Ordered by bucket start ascending
- `group` is `null` when `group_by` is omitted
- For `1h` / `1d` buckets without `q` or `attr.*` filters, results come from the pre-aggregated rollup table

## Schema and Index Design

### `logs` table

```sql
CREATE TABLE logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY,
    ts TIMESTAMPTZ NOT NULL,
    level log_level NOT NULL,
    service TEXT NOT NULL,
    message TEXT NOT NULL,
    attributes JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);
```

**Indexes**
- `(service, ts DESC, id DESC)`
- `(level, ts DESC)`
- `(ts DESC, id DESC)` — keyset pagination
- GIN (`jsonb_path_ops`) on `attributes`
- GIN trigram on `message` (sealed partitions)

Daily partitioning enables partition pruning and cheap retention via `DROP TABLE`.

### Hourly rollup table

```sql
CREATE TABLE logs_hourly_counts (
    hour TIMESTAMPTZ NOT NULL,
    service TEXT NOT NULL,
    level log_level NOT NULL,
    count BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (hour, service, level)
) UNLOGGED;
```

Updated on ingest. Used by aggregation queries for `1h` and `1d` buckets when no message/attribute filters are present.

## Attribute Storage Strategy

Attributes are stored as a single `JSONB` column.

- Flat key-value pairs only (validated on ingest)
- Equality filters use `attributes ->> 'key' = 'value'`
- Backed by a GIN index with `jsonb_path_ops` for efficient lookups and lower write cost

## Retention Strategy

- Controlled by `RETENTION_DAYS` (default: 30)
- Old daily partitions are dropped with `DROP TABLE`
- No row-level deletes, no bloat, no long-running locks
- Upcoming partitions are pre-created automatically

## Measured Performance Results

> Official results from the company load generator will be added after testing.

**Local results** (resource limits enforced: App 0.5 CPU / 256 MB, Postgres 1 CPU / 1 GB):

| Metric                                      | Result                        |
|---------------------------------------------|-------------------------------|
| Sustained ingestion throughput              | 16k – 24.5k logs/sec          |
| Ingestion under concurrent aggregation      | 19k – 21.5k logs/sec          |
| Aggregate p95 while ingestion is active     | 98 – 197 ms                   |
| Seed 1M rows                                | ~18 s                         |

## Known Limitations

- Message trigram index limits peak write throughput (kept for `q=` query performance)
- `synchronous_commit=off` trades a small durability window for higher write throughput
- Rollup updates are asynchronous and not in the same transaction as the main insert
- Very high concurrency (> ~50 connections) saturates the single-core Postgres limit

## Optional Features

None implemented.

`docker compose up` with no environment configuration serves all required endpoints unauthenticated and without rate limits or quotas.
```
