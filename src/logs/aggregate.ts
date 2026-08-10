import type { Request, Response } from "express";
import { sql } from "../db/client.js";
import { parseAggregateQuery, AggregateParams } from "./aggregateValidate.js";

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

// الـ rollup بيقدر يخدم بس لو ما فيه q أو attr (مش موجودين بجدول logs_hourly_counts أصلاً)
function canUseRollup(params: AggregateParams): boolean {
  const hasQOrAttrs = !!params.q || Object.keys(params.attrs).length > 0;
  return (params.bucket === "1h" || params.bucket === "1d") && !hasQOrAttrs;
}

async function queryRollup(params: AggregateParams, interval: string): Promise<BucketRow[]> {
  const conditions = [sql`hour >= ${params.since}`, sql`hour < ${params.until}`];
  if (params.service) conditions.push(sql`service = ${params.service}`);
  if (params.level) conditions.push(sql`level = ${params.level}::log_level`);
  const whereClause = conditions.reduce((acc, c) => sql`${acc} AND ${c}`);

  if (params.groupBy === "service") {
    return sql<BucketRow[]>`
      SELECT date_bin(${interval}::interval, hour, TIMESTAMPTZ '2001-01-01') AS start,
             service AS group, SUM(count)::int AS count
      FROM logs_hourly_counts WHERE ${whereClause}
      GROUP BY start, service ORDER BY start
    `;
  }
  if (params.groupBy === "level") {
    return sql<BucketRow[]>`
      SELECT date_bin(${interval}::interval, hour, TIMESTAMPTZ '2001-01-01') AS start,
             level AS group, SUM(count)::int AS count
      FROM logs_hourly_counts WHERE ${whereClause}
      GROUP BY start, level ORDER BY start
    `;
  }
  const rows = await sql<{ start: string; count: number }[]>`
    SELECT date_bin(${interval}::interval, hour, TIMESTAMPTZ '2001-01-01') AS start,
           SUM(count)::int AS count
    FROM logs_hourly_counts WHERE ${whereClause}
    GROUP BY start ORDER BY start
  `;
  return rows.map((r) => ({ ...r, group: null }));
}

async function queryLive(params: AggregateParams, interval: string): Promise<BucketRow[]> {
  const conditions = [sql`ts >= ${params.since}`, sql`ts < ${params.until}`];
  if (params.service) conditions.push(sql`service = ${params.service}`);
  if (params.level) conditions.push(sql`level = ${params.level}::log_level`);
  if (params.q) conditions.push(sql`message ILIKE ${"%" + params.q + "%"}`);
  for (const [key, value] of Object.entries(params.attrs)) {
    conditions.push(sql`attributes ->> ${key} = ${value}`);
  }
  const whereClause = conditions.reduce((acc, c) => sql`${acc} AND ${c}`);

  if (params.groupBy === "service") {
    return sql<BucketRow[]>`
      SELECT date_bin(${interval}::interval, ts, TIMESTAMPTZ '2001-01-01') AS start,
             service AS group, COUNT(*)::int AS count
      FROM logs WHERE ${whereClause}
      GROUP BY start, service ORDER BY start
    `;
  }
  if (params.groupBy === "level") {
    return sql<BucketRow[]>`
      SELECT date_bin(${interval}::interval, ts, TIMESTAMPTZ '2001-01-01') AS start,
             level AS group, COUNT(*)::int AS count
      FROM logs WHERE ${whereClause}
      GROUP BY start, level ORDER BY start
    `;
  }
  const rows = await sql<{ start: string; count: number }[]>`
    SELECT date_bin(${interval}::interval, ts, TIMESTAMPTZ '2001-01-01') AS start,
           COUNT(*)::int AS count
    FROM logs WHERE ${whereClause}
    GROUP BY start ORDER BY start
  `;
  return rows.map((r) => ({ ...r, group: null }));
}

export async function aggregateLogs(req: Request, res: Response) {
  try {
    const params = parseAggregateQuery(req.query as Record<string, unknown>);
    const interval = bucketToInterval(params.bucket);

    const buckets = canUseRollup(params)
      ? await queryRollup(params, interval)
      : await queryLive(params, interval);

    return res.status(200).json({ buckets });
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
}