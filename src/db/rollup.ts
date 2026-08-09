import { sql } from "./client.js";

interface AcceptedEntry {
  timestamp: string;
  level: string;
  service: string;
}

function truncHour(iso: string): string {
  const d = new Date(iso);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

export async function upsertHourlyCounts(entries: AcceptedEntry[]) {
  if (entries.length === 0) return;

  const counts = new Map<
    string,
    { hour: string; service: string; level: string; count: number }
  >();
  for (const e of entries) {
    const hour = truncHour(e.timestamp);
    const key = JSON.stringify([hour, e.service, e.level]);
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { hour, service: e.service, level: e.level, count: 1 });
    }
  }

  const hours: string[] = [];
  const services: string[] = [];
  const levels: string[] = [];
  const values: number[] = [];
  for (const row of counts.values()) {
    hours.push(row.hour);
    services.push(row.service);
    levels.push(row.level);
    values.push(row.count);
  }
  await sql`
    INSERT INTO logs_hourly_counts (hour, service, level, count)
    SELECT hour, service, level::log_level, count
    FROM UNNEST(
      ${hours}::timestamptz[],
      ${services}::text[],
      ${levels}::text[],
      ${values}::bigint[]
    ) AS t(hour, service, level, count)
    ON CONFLICT (hour, service, level)
    DO UPDATE SET count = logs_hourly_counts.count + EXCLUDED.count
  `;
}
