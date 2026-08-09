import type { Request, Response } from "express";
import { sql } from "../db/client.js";
import { parseAggregateQuery } from "./aggregateValidate.js";

function bucketToInterval(bucket: string): string {
  switch (bucket) {
    case "1m": return "1 minute";
    case "5m": return "5 minutes";
    case "1h": return "1 hour";
    case "1d": return "1 day";
    default: throw new Error("invalid bucket");
  }
}

interface BucketRow {
  start: string;
  group: string | null;
  count: number;
}

function canUseRollup(bucket: string): boolean {
  // الـ rollup محسوب بدقة ساعة، فمفيد بس لـ buckets أكبر أو تساوي ساعة
  return bucket === "1h" || bucket === "1d";
}

async function queryRollup(
  since: string,
  until: string,
  interval: string,
  groupBy?: "service" | "level"
): Promise<BucketRow[]> {
  if (groupBy === "service") {
    return sql<BucketRow[]>`
      SELECT
        date_bin(${interval}::interval, hour, TIMESTAMPTZ '2001-01-01') AS start,
        service AS group,
        SUM(count)::int AS count
      FROM logs_hourly_counts
      WHERE hour >= ${since} AND hour < ${until}
      GROUP BY start, service
      ORDER BY start
    `;
  }
  if (groupBy === "level") {
    return sql<BucketRow[]>`
      SELECT
        date_bin(${interval}::interval, hour, TIMESTAMPTZ '2001-01-01') AS start,
        level AS group,
        SUM(count)::int AS count
      FROM logs_hourly_counts
      WHERE hour >= ${since} AND hour < ${until}
      GROUP BY start, level
      ORDER BY start
    `;
  }
  const rows = await sql<{ start: string; count: number }[]>`
    SELECT
      date_bin(${interval}::interval, hour, TIMESTAMPTZ '2001-01-01') AS start,
      SUM(count)::int AS count
    FROM logs_hourly_counts
    WHERE hour >= ${since} AND hour < ${until}
    GROUP BY start
    ORDER BY start
  `;
  return rows.map((r) => ({ ...r, group: null }));
}

async function queryLive(
  since: string,
  until: string,
  interval: string,
  groupBy?: "service" | "level"
): Promise<BucketRow[]> {
  if (groupBy === "service") {
    return sql<BucketRow[]>`
      SELECT
        date_bin(${interval}::interval, ts, TIMESTAMPTZ '2001-01-01') AS start,
        service AS group,
        COUNT(*)::int AS count
      FROM logs
      WHERE ts >= ${since} AND ts < ${until}
      GROUP BY start, service
      ORDER BY start
    `;
  }
  if (groupBy === "level") {
    return sql<BucketRow[]>`
      SELECT
        date_bin(${interval}::interval, ts, TIMESTAMPTZ '2001-01-01') AS start,
        level AS group,
        COUNT(*)::int AS count
      FROM logs
      WHERE ts >= ${since} AND ts < ${until}
      GROUP BY start, level
      ORDER BY start
    `;
  }
  const rows = await sql<{ start: string; count: number }[]>`
    SELECT
      date_bin(${interval}::interval, ts, TIMESTAMPTZ '2001-01-01') AS start,
      COUNT(*)::int AS count
    FROM logs
    WHERE ts >= ${since} AND ts < ${until}
    GROUP BY start
    ORDER BY start
  `;
  return rows.map((r) => ({ ...r, group: null }));
}

export async function aggregateLogs(req: Request, res: Response) {
  try {
    const params = parseAggregateQuery(req.query as Record<string, unknown>);
    const interval = bucketToInterval(params.bucket);

    const buckets = canUseRollup(params.bucket)
      ? await queryRollup(params.since, params.until, interval, params.groupBy)
      : await queryLive(params.since, params.until, interval, params.groupBy);

    return res.status(200).json({ buckets });
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
}