import type { Request, Response } from "express";
import { readSql as sql } from "../db/client.js";
import {
  parseAggregateQuery,
  AggregateParams,
} from "./aggregateValidate.js";

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

const HOUR_MS = 60 * 60 * 1000;

function canUseRollup(params: AggregateParams): boolean {
  const hasQOrAttrs =
    !!params.q || Object.keys(params.attrs).length > 0;

  return (
    (params.bucket === "1h" || params.bucket === "1d") &&
    !hasQOrAttrs
  );
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

  return [...merged.values()].sort((a, b) =>
    a.start < b.start
      ? -1
      : a.start > b.start
        ? 1
        : 0
  );
}

async function queryRollup(
  params: AggregateParams,
  interval: string,
  since: string,
  until: string
): Promise<BucketRow[]> {
  const conditions = [
    sql`hour >= ${since}`,
    sql`hour < ${until}`,
  ];

  if (params.service) {
    conditions.push(
      sql`service = ${params.service}`
    );
  }

  if (params.level) {
    conditions.push(
      sql`level = ${params.level}::log_level`
    );
  }

  const whereClause = conditions.reduce(
    (acc, condition) => sql`${acc} AND ${condition}`
  );

  if (params.groupBy === "service") {
    return sql<BucketRow[]>`
      SELECT
        date_bin(
          ${interval}::interval,
          hour,
          TIMESTAMPTZ '2001-01-01'
        ) AS start,
        service AS group,
        SUM(count)::int AS count
      FROM logs_hourly_counts
      WHERE ${whereClause}
      GROUP BY start, service
      ORDER BY start
    `;
  }

  if (params.groupBy === "level") {
    return sql<BucketRow[]>`
      SELECT
        date_bin(
          ${interval}::interval,
          hour,
          TIMESTAMPTZ '2001-01-01'
        ) AS start,
        level AS group,
        SUM(count)::int AS count
      FROM logs_hourly_counts
      WHERE ${whereClause}
      GROUP BY start, level
      ORDER BY start
    `;
  }

  const rows = await sql<
    { start: string; count: number }[]
  >`
    SELECT
      date_bin(
        ${interval}::interval,
        hour,
        TIMESTAMPTZ '2001-01-01'
      ) AS start,
      SUM(count)::int AS count
    FROM logs_hourly_counts
    WHERE ${whereClause}
    GROUP BY start
    ORDER BY start
  `;

  return rows.map((row) => ({
    ...row,
    group: null,
  }));
}

async function queryLive(
  params: AggregateParams,
  interval: string,
  since: string,
  until: string
): Promise<BucketRow[]> {
  const conditions = [
    sql`ts >= ${since}`,
    sql`ts < ${until}`,
  ];

  if (params.service) {
    conditions.push(
      sql`service = ${params.service}`
    );
  }

  if (params.level) {
    conditions.push(
      sql`level = ${params.level}::log_level`
    );
  }

  if (params.q) {
    conditions.push(
      sql`message ILIKE ${"%" + params.q + "%"}`
    );
  }

  for (const [key, value] of Object.entries(
    params.attrs
  )) {
    conditions.push(
      sql`attributes ->> ${key} = ${value}`
    );
  }

  const whereClause = conditions.reduce(
    (acc, condition) => sql`${acc} AND ${condition}`
  );

  if (params.groupBy === "service") {
    return sql<BucketRow[]>`
      SELECT
        date_bin(
          ${interval}::interval,
          ts,
          TIMESTAMPTZ '2001-01-01'
        ) AS start,
        service AS group,
        COUNT(*)::int AS count
      FROM logs
      WHERE ${whereClause}
      GROUP BY start, service
      ORDER BY start
    `;
  }

  if (params.groupBy === "level") {
    return sql<BucketRow[]>`
      SELECT
        date_bin(
          ${interval}::interval,
          ts,
          TIMESTAMPTZ '2001-01-01'
        ) AS start,
        level AS group,
        COUNT(*)::int AS count
      FROM logs
      WHERE ${whereClause}
      GROUP BY start, level
      ORDER BY start
    `;
  }

  const rows = await sql<
    { start: string; count: number }[]
  >`
    SELECT
      date_bin(
        ${interval}::interval,
        ts,
        TIMESTAMPTZ '2001-01-01'
      ) AS start,
      COUNT(*)::int AS count
    FROM logs
    WHERE ${whereClause}
    GROUP BY start
    ORDER BY start
  `;

  return rows.map((row) => ({
    ...row,
    group: null,
  }));
}

async function runAggregate(
  params: AggregateParams,
  interval: string
): Promise<BucketRow[]> {
  /*
   * Queries using message search or JSON attributes
   * cannot use the rollup because the rollup does not
   * contain those fields.
   */
  if (!canUseRollup(params)) {
    return queryLive(
      params,
      interval,
      params.since,
      params.until
    );
  }

  const since = new Date(params.since);
  const until = new Date(params.until);

  const startHour = new Date(since);
  startHour.setUTCMinutes(0, 0, 0);

  const endHour = new Date(until);
  endHour.setUTCMinutes(0, 0, 0);

  /*
   * Query shorter than one hour:
   * there is no complete hourly rollup.
   */
  if (startHour.getTime() === endHour.getTime()) {
    return queryLive(
      params,
      interval,
      params.since,
      params.until
    );
  }

  const parts: BucketRow[][] = [];

  /*
   * First partial hour.
   *
   * Example:
   * 14:35 -> 15:00
   */
  if (
    since.getTime() <
    startHour.getTime() + HOUR_MS
  ) {
    const firstHourEnd = new Date(
      startHour.getTime() + HOUR_MS
    );

    const firstUntil =
      firstHourEnd.getTime() < until.getTime()
        ? firstHourEnd
        : until;

    if (since.getTime() < firstUntil.getTime()) {
      parts.push(
        await queryLive(
          params,
          interval,
          since.toISOString(),
          firstUntil.toISOString()
        )
      );
    }
  }

  /*
   * Complete hours.
   *
   * These are served from the rollup table.
   */
  const rollupSince = new Date(
    startHour.getTime() + HOUR_MS
  );

  const rollupUntil =
    endHour.getTime() < until.getTime()
      ? endHour
      : until;

  if (
    rollupSince.getTime() <
    rollupUntil.getTime()
  ) {
    parts.push(
      await queryRollup(
        params,
        interval,
        rollupSince.toISOString(),
        rollupUntil.toISOString()
      )
    );
  }

  /*
   * Last partial/current hour.
   */
  if (endHour.getTime() < until.getTime()) {
    parts.push(
      await queryLive(
        params,
        interval,
        endHour.toISOString(),
        until.toISOString()
      )
    );
  }

  return mergeBuckets(parts);
}

export async function aggregateLogs(
  req: Request,
  res: Response
) {
  try {
    const params = parseAggregateQuery(
      req.query as Record<string, unknown>
    );

    const interval = bucketToInterval(
      params.bucket
    );

    const buckets = await runAggregate(
      params,
      interval
    );

    return res.status(200).json({
      buckets,
    });
  } catch (error) {
    return res.status(400).json({
      error: (error as Error).message,
    });
  }
}