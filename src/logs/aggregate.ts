import type { Request, Response } from "express";
import { readSql as sql } from "../db/client.js";
import {
  parseAggregateQuery,
  AggregateParams,
} from "./aggregateValidate.js";
import { getCached, setCached } from "./aggregateCache.js";

function bucketToInterval(bucket: string): string {
  switch (bucket) {
    case "1m":
      return "1 minute";
    case "5m":
      return "5 minutes";
    case "1h":
      return "1 hour";
    case "1d":
      return "1 day";
    default:
      throw new Error("invalid bucket");
  }
}

interface BucketRow {
  start: string;
  group: string | null;
  count: number;
}

const ROLLUP_SAFETY_MARGIN_MS = 3000;

function canUseRollup(params: AggregateParams): boolean {
  if (params.q) return false;
  if (Object.keys(params.attrs).length > 0) return false;
  return true;
}

function floorToMinute(date: Date): Date {
  const d = new Date(date);
  d.setUTCSeconds(0, 0);
  return d;
}

function ceilToMinute(date: Date): Date {
  const floored = floorToMinute(date);
  if (floored.getTime() === date.getTime()) return floored;
  return new Date(floored.getTime() + 60_000);
}

function mergeBuckets(parts: BucketRow[][]): BucketRow[] {
  const merged = new Map<string, BucketRow>();

  for (const rows of parts) {
    for (const row of rows) {
      const key = `${row.start}|${row.group ?? ""}`;
      const existing = merged.get(key);
      if (existing) {
        existing.count += row.count;
      } else {
        merged.set(key, { ...row });
      }
    }
  }

  return [...merged.values()].sort((a, b) => {
    if (a.start < b.start) return -1;
    if (a.start > b.start) return 1;
    const aGroup = a.group ?? "";
    const bGroup = b.group ?? "";
    return aGroup.localeCompare(bGroup);
  });
}

function buildRollupConditions(
  params: AggregateParams,
  since: string,
  until: string,
) {
  const conditions = [
    sql`minute >= ${since}`,
    sql`minute < ${until}`,
  ];

  if (params.service) {
    conditions.push(sql`service = ${params.service}`);
  }
  if (params.level) {
    conditions.push(sql`level = ${params.level}::log_level`);
  }

  return conditions.reduce(
    (acc, condition) => sql`${acc} AND ${condition}`,
  );
}

async function queryRollup(
  params: AggregateParams,
  interval: string,
  since: string,
  until: string,
): Promise<BucketRow[]> {
  const whereClause = buildRollupConditions(params, since, until);

  if (params.groupBy === "service") {
    return sql<BucketRow[]>`
      SELECT
        date_bin(${interval}::interval, minute, TIMESTAMPTZ '2001-01-01') AS start,
        service AS group,
        SUM(count)::int AS count
      FROM logs_minute_counts
      WHERE ${whereClause}
      GROUP BY start, service
      ORDER BY start, service
    `;
  }

  if (params.groupBy === "level") {
    return sql<BucketRow[]>`
      SELECT
        date_bin(${interval}::interval, minute, TIMESTAMPTZ '2001-01-01') AS start,
        level AS group,
        SUM(count)::int AS count
      FROM logs_minute_counts
      WHERE ${whereClause}
      GROUP BY start, level
      ORDER BY start, level
    `;
  }

  return sql<{ start: string; count: number }[]>`
    SELECT
      date_bin(${interval}::interval, minute, TIMESTAMPTZ '2001-01-01') AS start,
      SUM(count)::int AS count
    FROM logs_minute_counts
    WHERE ${whereClause}
    GROUP BY start
    ORDER BY start
  `.then((rows) => rows.map((row) => ({ ...row, group: null })));
}

function buildLiveConditions(
  params: AggregateParams,
  since: string,
  until: string,
) {
  const conditions = [
    sql`ts >= ${since}`,
    sql`ts < ${until}`,
  ];

  if (params.service) {
    conditions.push(sql`service = ${params.service}`);
  }
  if (params.level) {
    conditions.push(sql`level = ${params.level}::log_level`);
  }
  if (params.q) {
    conditions.push(sql`message ILIKE ${"%" + params.q + "%"}`);
  }
  for (const [key, value] of Object.entries(params.attrs)) {
    conditions.push(sql`attributes ->> ${key} = ${value}`);
  }

  return conditions.reduce(
    (acc, condition) => sql`${acc} AND ${condition}`,
  );
}

async function queryLive(
  params: AggregateParams,
  interval: string,
  since: string,
  until: string,
): Promise<BucketRow[]> {
  const whereClause = buildLiveConditions(params, since, until);

  if (params.groupBy === "service") {
    return sql<BucketRow[]>`
      SELECT
        date_bin(${interval}::interval, ts, TIMESTAMPTZ '2001-01-01') AS start,
        service AS group,
        COUNT(*)::int AS count
      FROM logs
      WHERE ${whereClause}
      GROUP BY start, service
      ORDER BY start, service
    `;
  }

  if (params.groupBy === "level") {
    return sql<BucketRow[]>`
      SELECT
        date_bin(${interval}::interval, ts, TIMESTAMPTZ '2001-01-01') AS start,
        level AS group,
        COUNT(*)::int AS count
      FROM logs
      WHERE ${whereClause}
      GROUP BY start, level
      ORDER BY start, level
    `;
  }

  return sql<{ start: string; count: number }[]>`
    SELECT
      date_bin(${interval}::interval, ts, TIMESTAMPTZ '2001-01-01') AS start,
      COUNT(*)::int AS count
    FROM logs
    WHERE ${whereClause}
    GROUP BY start
    ORDER BY start
  `.then((rows) => rows.map((row) => ({ ...row, group: null })));
}

async function runAggregate(
  params: AggregateParams,
  interval: string,
): Promise<BucketRow[]> {
  if (!canUseRollup(params)) {
    return queryLive(params, interval, params.since, params.until);
  }

  const since = new Date(params.since);
  const until = new Date(params.until);
  const safeUntil = new Date(
    Math.min(until.getTime(), Date.now() - ROLLUP_SAFETY_MARGIN_MS),
  );

  if (safeUntil.getTime() <= since.getTime()) {
    return queryLive(params, interval, params.since, params.until);
  }

  const rollupStart = ceilToMinute(since);
  const rollupEnd = floorToMinute(safeUntil);

  const queries: Promise<BucketRow[]>[] = [];

  // الجزء الجزئي من أول دقيقة: [since, rollupStart)
  if (rollupStart.getTime() > since.getTime()) {
    const headEnd =
      rollupStart.getTime() < safeUntil.getTime() ? rollupStart : safeUntil;
    queries.push(
      queryLive(
        params,
        interval,
        since.toISOString(),
        headEnd.toISOString(),
      ),
    );
  }

  // الدقائق الكاملة عبر rollup: [rollupStart, rollupEnd)
  if (rollupStart.getTime() < rollupEnd.getTime()) {
    queries.push(
      queryRollup(
        params,
        interval,
        rollupStart.toISOString(),
        rollupEnd.toISOString(),
      ),
    );
  }

  // الجزء الجزئي قبل هامش الأمان: [rollupEnd, safeUntil)
  if (
    rollupEnd.getTime() < safeUntil.getTime() &&
    rollupEnd.getTime() >= rollupStart.getTime()
  ) {
    queries.push(
      queryLive(
        params,
        interval,
        rollupEnd.toISOString(),
        safeUntil.toISOString(),
      ),
    );
  }

  // الذيل الأخير بعد هامش الأمان: [safeUntil, until)
  if (safeUntil.getTime() < until.getTime()) {
    queries.push(
      queryLive(
        params,
        interval,
        safeUntil.toISOString(),
        until.toISOString(),
      ),
    );
  }

  const parts = await Promise.all(queries);
  return mergeBuckets(parts);
}

export async function aggregateLogs(req: Request, res: Response) {
  try {
    const params = parseAggregateQuery(
      req.query as Record<string, unknown>,
    );

    const cacheKey = JSON.stringify(params);
    const cached = getCached(cacheKey);
    if (cached !== undefined) {
      return res.status(200).json({ buckets: cached });
    }

    const interval = bucketToInterval(params.bucket);
    const buckets = await runAggregate(params, interval);

    setCached(cacheKey, buckets);
    return res.status(200).json({ buckets });
  } catch (error) {
    return res.status(400).json({
      error: (error as Error).message,
    });
  }
}