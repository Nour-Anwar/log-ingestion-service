import { sql } from "./client.js";

interface AcceptedEntry {
  timestamp: string;
  level: string;
  service: string;
}

interface RollupRow {
  hour: string;
  service: string;
  level: string;
  count: number;
}

const ROLLUP_FLUSH_INTERVAL_MS = 150;
const MAX_PENDING_GROUPS = 5000;

let pending = new Map<string, RollupRow>();
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function truncHour(iso: string): string {
  const date = new Date(iso);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function mergeEntries(entries: AcceptedEntry[]) {
  for (const entry of entries) {
    const hour = truncHour(entry.timestamp);
    const key = `${hour}|${entry.service}|${entry.level}`;
    const existing = pending.get(key);
    if (existing) {
      existing.count++;
      continue;
    }
    pending.set(key, {
      hour,
      service: entry.service,
      level: entry.level,
      count: 1,
    });
  }
}

function scheduleDrain() {
  if (timer !== null || flushing || pending.size === 0) {
    return;
  }
  timer = setTimeout(() => {
    timer = null;
    void drain();
  }, ROLLUP_FLUSH_INTERVAL_MS);
}

function takePendingBatch(): Map<string, RollupRow> {
  const batch = pending;
  pending = new Map();
  return batch;
}

async function drain() {
  if (flushing || pending.size === 0) {
    scheduleDrain();
    return;
  }

  flushing = true;
  const batch = takePendingBatch();

  try {
    const rows = [...batch.values()];
    if (rows.length === 0) {
      return;
    }

    const hours = rows.map((row) => row.hour);
    const services = rows.map((row) => row.service);
    const levels = rows.map((row) => row.level);
    const counts = rows.map((row) => row.count);

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
        ${counts}::bigint[]
      ) AS incoming(
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
    if (pending.size >= MAX_PENDING_GROUPS) {
      void drain();
    } else {
      scheduleDrain();
    }
  }
}

export function queueRollupCounts(entries: AcceptedEntry[]) {
  if (entries.length === 0) {
    return;
  }

  mergeEntries(entries);

  if (pending.size >= MAX_PENDING_GROUPS) {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!flushing) {
      void drain();
    }
    return;
  }

  scheduleDrain();
}