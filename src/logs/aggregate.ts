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

interface GroupedBucketRow {
  start: string;
  group: string;
  count: number;
}

interface PlainBucketRow {
  start: string;
  count: number;
}

export async function aggregateLogs(req: Request, res: Response) {
  try {
    const params = parseAggregateQuery(req.query as Record<string, unknown>);
    const interval = bucketToInterval(params.bucket);

    let buckets: { start: string; group: string | null; count: number }[];

    if (params.groupBy === "service") {
      const rows = await sql<GroupedBucketRow[]>`
        SELECT
          date_bin(${interval}::interval, ts, TIMESTAMPTZ '2001-01-01') AS start,
          service AS group,
          COUNT(*)::int AS count
        FROM logs
        WHERE ts >= ${params.since} AND ts < ${params.until}
        GROUP BY start, service
        ORDER BY start
      `;
      buckets = rows;
    } else if (params.groupBy === "level") {
      const rows = await sql<GroupedBucketRow[]>`
        SELECT
          date_bin(${interval}::interval, ts, TIMESTAMPTZ '2001-01-01') AS start,
          level AS group,
          COUNT(*)::int AS count
        FROM logs
        WHERE ts >= ${params.since} AND ts < ${params.until}
        GROUP BY start, level
        ORDER BY start
      `;
      buckets = rows;
    } else {
      const rows = await sql<PlainBucketRow[]>`
        SELECT
          date_bin(${interval}::interval, ts, TIMESTAMPTZ '2001-01-01') AS start,
          COUNT(*)::int AS count
        FROM logs
        WHERE ts >= ${params.since} AND ts < ${params.until}
        GROUP BY start
        ORDER BY start
      `;
      buckets = rows.map((r) => ({ ...r, group: null }));
    }

    return res.status(200).json({ buckets });
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
}