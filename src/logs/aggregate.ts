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
  /*
   * الـ rollup يحتوي فقط:
   * hour + service + level + count
   *
   * لذلك لا يمكن استخدامه مع:
   * q
   * attributes
   */
  if (params.q) {
    return false;
  }

  if (Object.keys(params.attrs).length > 0) {
    return false;
  }

  return (
    params.bucket === "1h" ||
    params.bucket === "1d"
  );
}

function mergeBuckets(
  parts: BucketRow[][],
): BucketRow[] {
  const merged = new Map<string, BucketRow>();

  for (const rows of parts) {
    for (const row of rows) {
      const key = `${row.start}|${row.group ?? ""}`;

      const existing = merged.get(key);

      if (existing) {
        existing.count += row.count;
      } else {
        merged.set(key, {
          start: row.start,
          group: row.group,
          count: row.count,
        });
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
    sql`hour >= ${since}`,
    sql`hour < ${until}`,
  ];

  if (params.service) {
    conditions.push(
      sql`service = ${params.service}`,
    );
  }

  if (params.level) {
    conditions.push(
      sql`level = ${params.level}::log_level`,
    );
  }

  return conditions.reduce(
    (acc, condition) =>
      sql`${acc} AND ${condition}`,
  );
}

async function queryRollup(
  params: AggregateParams,
  interval: string,
  since: string,
  until: string,
): Promise<BucketRow[]> {
  const whereClause = buildRollupConditions(
    params,
    since,
    until,
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
        SUM(count)::bigint AS count
      FROM logs_hourly_counts
      WHERE ${whereClause}
      GROUP BY start, service
      ORDER BY start, service
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
        SUM(count)::bigint AS count
      FROM logs_hourly_counts
      WHERE ${whereClause}
      GROUP BY start, level
      ORDER BY start, level
    `;
  }

  return sql<{ start: string; count: number }[]>`
    SELECT
      date_bin(
        ${interval}::interval,
        hour,
        TIMESTAMPTZ '2001-01-01'
      ) AS start,
      SUM(count)::bigint AS count
    FROM logs_hourly_counts
    WHERE ${whereClause}
    GROUP BY start
    ORDER BY start
  `.then((rows) =>
    rows.map((row) => ({
      start: row.start,
      group: null,
      count: row.count,
    })),
  );
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
    conditions.push(
      sql`service = ${params.service}`,
    );
  }

  if (params.level) {
    conditions.push(
      sql`level = ${params.level}::log_level`,
    );
  }

  if (params.q) {
    conditions.push(
      sql`message ILIKE ${"%" + params.q + "%"}`,
    );
  }

  for (const [key, value] of Object.entries(
    params.attrs,
  )) {
    conditions.push(
      sql`attributes ->> ${key} = ${value}`,
    );
  }

  return conditions.reduce(
    (acc, condition) =>
      sql`${acc} AND ${condition}`,
  );
}

async function queryLive(
  params: AggregateParams,
  interval: string,
  since: string,
  until: string,
): Promise<BucketRow[]> {
  const whereClause = buildLiveConditions(
    params,
    since,
    until,
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
        COUNT(*)::bigint AS count
      FROM logs
      WHERE ${whereClause}
      GROUP BY start, service
      ORDER BY start, service
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
        COUNT(*)::bigint AS count
      FROM logs
      WHERE ${whereClause}
      GROUP BY start, level
      ORDER BY start, level
    `;
  }

  return sql<{ start: string; count: number }[]>`
    SELECT
      date_bin(
        ${interval}::interval,
        ts,
        TIMESTAMPTZ '2001-01-01'
      ) AS start,
      COUNT(*)::bigint AS count
    FROM logs
    WHERE ${whereClause}
    GROUP BY start
    ORDER BY start
  `.then((rows) =>
    rows.map((row) => ({
      start: row.start,
      group: null,
      count: row.count,
    })),
  );
}

async function runAggregate(
  params: AggregateParams,
  interval: string,
): Promise<BucketRow[]> {
  
  if (!canUseRollup(params)) {
    return queryLive(
      params,
      interval,
      params.since,
      params.until,
    );
  }

  const since = new Date(params.since);
  const until = new Date(params.until);

  const startHour = new Date(since);
  startHour.setUTCMinutes(0, 0, 0);

  const endHour = new Date(until);
  endHour.setUTCMinutes(0, 0, 0);

  
  if (
    startHour.getTime() === endHour.getTime()
  ) {
    return queryLive(
      params,
      interval,
      params.since,
      params.until,
    );
  }

  const parts: BucketRow[][] = [];

  /*
   * PART 1:
   * الجزء الأول من الساعة.
   *
   * مثال:
   * 14:35 → 15:00
   */
  if (
    since.getTime() <
    startHour.getTime() + HOUR_MS
  ) {
    const firstHourEnd = new Date(
      startHour.getTime() + HOUR_MS,
    );

    const firstUntil =
      firstHourEnd.getTime() < until.getTime()
        ? firstHourEnd
        : until;

    if (
      since.getTime() <
      firstUntil.getTime()
    ) {
      parts.push(
        await queryLive(
          params,
          interval,
          since.toISOString(),
          firstUntil.toISOString(),
        ),
      );
    }
  }

  
  const rollupSince = new Date(
    startHour.getTime() + HOUR_MS,
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
        rollupUntil.toISOString(),
      ),
    );
  }

  
  if (
    endHour.getTime() <
    until.getTime()
  ) {
    parts.push(
      await queryLive(
        params,
        interval,
        endHour.toISOString(),
        until.toISOString(),
      ),
    );
  }

  return mergeBuckets(parts);
}

export async function aggregateLogs(
  req: Request,
  res: Response,
) {
  try {
    const params = parseAggregateQuery(
      req.query as Record<string, unknown>,
    );

    const interval = bucketToInterval(
      params.bucket,
    );

    const buckets = await runAggregate(
      params,
      interval,
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