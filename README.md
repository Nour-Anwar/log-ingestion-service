# Log Ingestion and Query Service

High-throughput service for ingesting, storing, querying, and aggregating structured logs on PostgreSQL.

Built to sustain **15,000+ logs/sec** under constrained Docker resources while keeping aggregate queries responsive during active ingestion.

**Stack:** TypeScript · Express · PostgreSQL · Drizzle ORM · Docker

---

## Performance at a Glance

| Metric | Latest Result |
|---|---:|
| Sustained ingestion target | **15,000 logs/sec** |
| Realistic ingestion throughput | **15,047 logs/sec** |
| Combined ingestion throughput | **33,751 logs/sec** |
| Aggregate p95 during ingestion | **98 ms** |
| Aggregate p99 during ingestion | **122 ms** |
| Aggregate failures during combined test | **0** |
| HTTP errors during realistic test | **0** |
| Logs accepted in realistic test | **1,806,500** |
| Eventual query visibility | **100%** |

Benchmarks were performed under the project's constrained Docker limits:

```text
Application:  0.5 CPU / 256 MB
PostgreSQL:   1 CPU / 1 GB
```

### Highlights

- High-throughput batch ingestion using PostgreSQL `COPY`
- Per-entry validation with partial batch success
- Cursor-based (keyset) pagination
- Daily range partitioning with automatic retention
- Pre-aggregated hourly rollups for fast aggregation under write load
- JSONB attribute filtering
- Case-insensitive message substring search
- Dedicated PostgreSQL connection pools for writes, reads, and rollups
- Optimized PostgreSQL configuration for the constrained benchmark environment
- Load-test suite covering ingestion, querying, combined workloads, realistic open-loop traffic, and stress scenarios
- Eventual-consistency verification after sustained ingestion

---

## Architecture

The service separates the main database workloads to reduce contention:

```text
                         ┌─────────────────────┐
                         │      HTTP API       │
                         │      Express        │
                         └──────────┬──────────┘
                                    │
                    ┌───────────────┼────────────────┐
                    │               │                │
                    ▼               ▼                ▼
              Ingestion          Queries          Aggregation
                    │               │                │
                    ▼               ▼                ▼
              Write Pool        Read Pool       Rollup Pool
                    │               │                │
                    └───────────────┼────────────────┘
                                    ▼
                              PostgreSQL
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
              ▼                     ▼                     ▼
        Daily log partitions   Hourly rollups       Query indexes
```

The application uses separate PostgreSQL client pools for:

- ingestion and write traffic
- read/query traffic
- rollup updates

This prevents read and aggregation workloads from unnecessarily consuming the connections dedicated to ingestion.

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

Database migrations and partition initialization run automatically during startup.

The service is ready when:

```bash
GET /health
```

returns:

```text
200 OK
```

Always use `docker compose up --build` after pulling code that changes the application image.

---

## API

### GET /health

Readiness endpoint.

Returns `200` once:

- PostgreSQL is reachable
- migrations have been applied
- required initialization has completed
- the application is ready to serve traffic

### POST /logs

Ingest a batch of structured logs.

#### Request

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
        "region": "eu-west"
      }
    }
  ]
}
```

#### Validation

Each entry is validated independently.

| Field       | Rule                                                                 |
|-------------|----------------------------------------------------------------------|
| timestamp   | Required, valid ISO 8601, no more than 5 minutes in the future      |
| level       | `debug`, `info`, `warn`, or `error`                                  |
| service     | Required, non-empty string                                           |
| message     | Required, non-empty string                                           |
| attributes  | Optional flat object containing string/number/boolean values         |

Invalid entries do not invalidate the entire batch.

#### Successful response

```json
{
  "accepted": 9,
  "rejected": [
    {
      "index": 3,
      "reason": "invalid level: 'critical'"
    }
  ]
}
```

Returns:

- `200` when at least one entry is accepted
- `400` when the request body is malformed or every entry is rejected

### GET /logs

Query stored logs using combinable filters.

#### Parameters

| Parameter   | Description                          | Example                          |
|-------------|--------------------------------------|----------------------------------|
| service     | Exact service match                  | `service=checkout`               |
| level       | Exact level match                    | `level=error`                    |
| since       | Inclusive start of time range        | `since=2026-08-01T14:00:00Z`     |
| until       | Exclusive end of time range          | `until=2026-08-01T15:00:00Z`     |
| attr.<key>  | Attribute equality filter            | `attr.user_id=42`                |
| q           | Case-insensitive message substring   | `q=declined`                     |
| limit       | Number of results, default 100, max 1000 | `limit=500`                   |
| cursor      | Opaque keyset pagination cursor      | `cursor=eyJpZCI6...`             |

Results are ordered by:

```text
timestamp DESC, id DESC
```

#### Response

```json
{
  "logs": [
    {
      "id": 123,
      "timestamp": "2026-08-01T14:32:01.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": {
        "user_id": "42"
      }
    }
  ],
  "next_cursor": "eyJpZCI6..."
}
```

The cursor is opaque to clients.

Keyset pagination avoids the increasing cost of large `OFFSET` values and keeps pagination predictable as page depth increases.

Invalid parameters return HTTP `400` with:

```json
{
  "error": "<description>"
}
```

### GET /logs/aggregate

Returns time-bucketed log counts.

Supports the same filtering options as `GET /logs`.

#### Required parameters

| Parameter | Description              | Example                          |
|-----------|--------------------------|----------------------------------|
| since     | Inclusive start          | `since=2026-08-01T00:00:00Z`     |
| until     | Exclusive end            | `until=2026-08-02T00:00:00Z`     |
| bucket    | `1m`, `5m`, `1h`, or `1d`| `bucket=1h`                      |

#### Optional parameters

- `group_by=service`
- `group_by=level`

#### Response

```json
{
  "buckets": [
    {
      "start": "2026-08-01T14:00:00Z",
      "group": "checkout",
      "count": 118
    }
  ]
}
```

Results are ordered by bucket start ascending.

When `group_by` is omitted:

```json
{
  "group": null
}
```

For hourly and daily aggregation without message or attribute filters, the service can use the pre-aggregated hourly rollup table instead of scanning the raw log rows.

Invalid parameters return HTTP `400` using the same error format as `GET /logs`.

---

## Database Design

### Logs

The main log table is partitioned by timestamp:

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

Daily range partitions provide:

- partition pruning for time-bounded queries
- bounded index sizes
- predictable retention operations
- cheap removal of expired data

Retention removes complete partitions rather than deleting individual rows.

### Index Strategy

The project deliberately avoids unnecessary indexes on the write-heavy logs table.

Important indexes include:

- `(service, ts DESC, id DESC)`
- `(ts DESC, id DESC)`
- `GIN(attributes jsonb_path_ops)`
- `GIN(message gin_trgm_ops)`

The timestamp/id index supports keyset pagination:

```sql
ORDER BY ts DESC, id DESC
```

The service/timestamp index supports service-scoped queries while preserving efficient time ordering.

The JSONB index supports attribute-oriented filtering.

The trigram index supports case-insensitive substring searches through:

```text
q=<substring>
```

The message index has a measurable write cost and is intentionally retained because it provides the query capability required by the API.

### Hourly Rollups

The service maintains an hourly aggregation table:

```sql
CREATE TABLE logs_hourly_counts (
    hour TIMESTAMPTZ NOT NULL,
    service TEXT NOT NULL,
    level log_level NOT NULL,
    count BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (hour, service, level)
) UNLOGGED;
```

The rollup is used for:

- `1h` aggregation
- `1d` aggregation

when no `q` or `attr.*` filters are present.

This avoids repeatedly scanning large volumes of raw log records during common aggregation requests.

The rollup workload uses its own PostgreSQL connection pool.

### Attribute Storage

Attributes are stored as a single JSONB document:

```json
{
  "user_id": "42",
  "region": "eu-west",
  "retry": true
}
```

Only flat key/value objects are accepted.

Supported value types:

- string
- number
- boolean

This avoids the additional joins and row amplification associated with an EAV-style schema.

Attribute filters use expressions such as:

```sql
attributes ->> 'user_id'
```

with the JSONB index providing support for attribute-oriented queries.

### Retention

Retention is controlled through:

```text
RETENTION_DAYS
```

Default:

```text
30 days
```

The service manages daily partitions and removes expired partitions with:

```sql
DROP TABLE
```

This avoids the operational cost of large row-level `DELETE` operations, including:

- massive delete transactions
- table/index bloat
- prolonged row locking
- expensive cleanup work

Upcoming partitions are also created automatically.

---

## Performance

Benchmarks were performed under constrained Docker resources:

```text
Application: 0.5 CPU / 256 MB
PostgreSQL:  1 CPU / 1 GB
```

The results below are local measurements from the repository's load-test suite.

### Combined Ingestion + Aggregation

A 120-second workload runs ingestion concurrently with one aggregate request per second.

Latest observed run:

```text
Ingestion requests/sec:       1022.8
Ingestion logs/sec:          33751

Aggregate requests:            120
Aggregate failures:              0

Aggregate p50:                  4 ms
Aggregate p95:                 98 ms
Aggregate p99:                122 ms
Aggregate max:                891 ms

Errors:                          0
Timeouts:                        0
```

Result:

```text
PASS — aggregate p95 < 1000 ms while ingestion was active
```

Another observed run achieved:

```text
33872 logs/sec
```

Aggregate:

```text
p50:    5 ms
p95:   89 ms
p99:  115 ms
max:   135 ms
```

### Realistic Open-Loop Ingestion

The realistic workload targets:

```text
15,000 logs/sec
120 seconds
```

The workload continuously sends traffic at the target rate instead of waiting for previous requests to complete.

Latest observed run:

```text
Target:              15,000 logs/sec
Achieved:            15,047 logs/sec

Requests sent:           3,613
Accepted logs:       1,806,500
Rejected logs:               0
HTTP errors:                0

Latency:
p50:  68 ms
p95: 104 ms
p99: 110 ms
```

After the ingestion phase, the service verified eventual query visibility:

```text
Accepted:       1,806,500
Visible:        1,806,500
Visibility:     100%
```

Result:

```text
PASS — all accepted logs became queryable
```

### Load Testing

The repository contains multiple workload profiles:

```text
scripts/
├── load-test-ingest.ts
├── load-test-query.ts
├── load-test-combined.ts
├── load-test-realistic.ts
└── load-test-stress.ts
```

**Combined workload**

Runs ingestion and aggregation concurrently:

```bash
npm run load:combined
```

**Realistic open-loop workload**

Targets 15,000 logs/sec for 120 seconds and then verifies eventual consistency:

```bash
npm run load:realistic
```

**Ingestion benchmark**

```bash
npm run load:ingest
```

**Query benchmark**

```bash
npm run load:query
```

**Stress workload**

```bash
npm run load:stress
```

### Resource Profile

During the latest realistic workload, Docker reported approximately:

**Application**

```text
CPU:      ~20–28%
Memory:   ~65 MB / 256 MB
```

**PostgreSQL**

```text
CPU:      ~18–28%
Memory:   ~672 MB / 1 GB
```

The workload remained within the configured container resource limits.

The resource profile also shows that PostgreSQL is the primary constrained component under the benchmark workload rather than the Node.js application.

---

## Testing

Run the test suite with:

```bash
npm test
```

The test suite covers:

- health/readiness
- ingestion validation
- partial batch success
- query filtering
- cursor pagination
- aggregation
- grouping

Tests use a real PostgreSQL instance rather than mocking the database layer.

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
│   │   │   ├── 0004_unlogged_rollup.sql
│   │   │   ├── 0005_drop_level_index.sql
│   │   │   ├── 0006_drop_duplicate_ts_index.sql
│   │   │   └── 0007_drop_redundant_service_index.sql
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

---

## Design Decisions & Trade-offs

### PostgreSQL COPY

Batch ingestion uses PostgreSQL `COPY` instead of issuing one `INSERT` per log.

This reduces SQL statement overhead and significantly improves throughput for large batches.

### Keyset Pagination

The API uses `(timestamp, id)` cursors rather than `OFFSET`.

This avoids the increasing cost of scanning and discarding rows as pagination moves deeper into a dataset.

### Partitioning

Daily partitions make time-based queries easier to prune and turn retention into a metadata operation instead of a large delete.

### Rollups

Hourly pre-aggregation reduces the amount of raw data that needs to be scanned for common aggregation workloads.

This is particularly important when aggregation requests run concurrently with heavy ingestion.

### Separate Connection Pools

The database client maintains dedicated pools for different workloads:

- Write pool
- Rollup pool
- Read pool

This prevents ingestion from consuming every available database connection and gives query/aggregation traffic independent capacity.

### synchronous_commit=off

The ingestion connection uses:

```text
synchronous_commit=off
```

This improves write throughput by allowing PostgreSQL to acknowledge commits before WAL flush completion.

This is an intentional durability/performance trade-off: a small window of recently acknowledged transactions may be lost if the database crashes before the corresponding WAL records are flushed.

### UNLOGGED Rollups

The hourly rollup table is:

```text
UNLOGGED
```

because it is derived data that can be rebuilt from the primary log dataset.

This reduces WAL overhead for rollup writes.

### Index Trade-offs

The trigram message index improves:

```text
q=<substring>
```

queries but increases write amplification.

It is therefore retained intentionally rather than treating every possible index as beneficial.

The project also includes migrations that remove redundant indexes discovered during performance tuning.

---

## Known Limitations

- PostgreSQL is constrained to a single CPU in the benchmark environment.
- Extremely high concurrency can saturate PostgreSQL before the Node.js application becomes the bottleneck.
- The trigram message index has a measurable ingestion cost.
- `synchronous_commit=off` provides higher throughput at the cost of a small durability window.
- Rollup updates are intentionally decoupled from the main ingestion transaction.
- Local benchmark results can vary depending on host CPU scheduling and WSL2 resource contention.
- The reported benchmark numbers are local measurements under the documented resource limits and are not hardware-independent guarantees.

---

## Optional Features

The current implementation intentionally does not include:

- authentication
- API keys
- multi-tenancy
- rate limiting
- quotas

The default Docker deployment exposes the API without authentication or rate limits.

A plain `docker compose up` with no environment file, no arguments, and no manual setup produces a service that:

- Serves `GET /health`, `POST /logs`, `GET /logs`, and `GET /logs/aggregate` exactly as specified
- Accepts unauthenticated requests on all four
- Applies no rate limit, quota, or tenancy restriction

---

## License

MIT
