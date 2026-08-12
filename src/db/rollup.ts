import { sql } from "./client.js";

interface AcceptedEntry {
  timestamp: string;
  level: string;
  service: string;
}

const ROLLUP_FLUSH_INTERVAL_MS = 50;

let pending = new Map<
  string,
  {
    hour: string;
    service: string;
    level: string;
    count: number;
  }
>();

let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function truncHour(iso: string): string {
  const d = new Date(iso);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function mergeEntries(entries: AcceptedEntry[]) {
  for (const entry of entries) {
    const hour = truncHour(entry.timestamp);
    const key = `${hour}|${entry.service}|${entry.level}`;

    const existing = pending.get(key);

    if (existing) {
      existing.count += 1;
    } else {
      pending.set(key, {
        hour,
        service: entry.service,
        level: entry.level,
        count: 1,
      });
    }
  }
}

function scheduleDrain() {
  if (timer || flushing || pending.size === 0) {
    return;
  }

  timer = setTimeout(() => {
    timer = null;
    void drain();
  }, ROLLUP_FLUSH_INTERVAL_MS);
}

async function drain() {
  if (flushing || pending.size === 0) {
    scheduleDrain();
    return;
  }

  flushing = true;

  const batch = pending;
  pending = new Map();

  try {
    const hours: string[] = [];
    const services: string[] = [];
    const levels: string[] = [];
    const values: number[] = [];

    for (const row of batch.values()) {
      hours.push(row.hour);
      services.push(row.service);
      levels.push(row.level);
      values.push(row.count);
    }

    await sql`
      INSERT INTO logs_hourly_counts (
        hour,
        service,
        level,
        count
      )
      SELECT
        hour,
        service,
        level::log_level,
        count
      FROM UNNEST(
        ${hours}::timestamptz[],
        ${services}::text[],
        ${levels}::text[],
        ${values}::bigint[]
      ) AS t(
        hour,
        service,
        level,
        count
      )
      ON CONFLICT (hour, service, level)
      DO UPDATE SET
        count =
          logs_hourly_counts.count + EXCLUDED.count
    `;
  } catch (error) {
    /*
     * Don't silently lose the batch.
     *
     * Put it back into pending so the next drain
     * can retry it.
     */
    for (const [key, row] of batch) {
      const existing = pending.get(key);

      if (existing) {
        existing.count += row.count;
      } else {
        pending.set(key, row);
      }
    }

    console.error("[rollup] batched upsert failed:", error);
  } finally {
    flushing = false;
    scheduleDrain();
  }
}

export function queueRollupCounts(entries: AcceptedEntry[]) {
  if (entries.length === 0) {
    return;
  }

  mergeEntries(entries);
  scheduleDrain();
}