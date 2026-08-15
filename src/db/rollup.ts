import { rollupSql as sql } from "./client.js";

interface AcceptedEntry {
  timestamp: string;
  level: string;
  service: string;
}

interface RollupRow {
  minute: string;
  service: string;
  level: string;
  count: number;
}

const ROLLUP_FLUSH_INTERVAL_MS = 150;
const MAX_PENDING_GROUPS = 5000;

let pending = new Map<string, RollupRow>();
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function truncMinute(iso: string): string {
  const date = new Date(iso);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

function mergeEntries(entries: AcceptedEntry[]) {
  for (const entry of entries) {
    const minute = truncMinute(entry.timestamp);
    const key = `${minute}|${entry.service}|${entry.level}`;
    const existing = pending.get(key);
    if (existing) {
      existing.count++;
      continue;
    }
    pending.set(key, {
      minute,
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

    const minutes = rows.map((row) => row.minute);
    const services = rows.map((row) => row.service);
    const levels = rows.map((row) => row.level);
    const counts = rows.map((row) => row.count);

    await sql`
      INSERT INTO logs_minute_counts (
        minute,
        service,
        level,
        count
      )
      SELECT
        minute,
        service,
        level::log_level,
        count
      FROM UNNEST(
        ${minutes}::timestamptz[],
        ${services}::text[],
        ${levels}::text[],
        ${counts}::bigint[]
      ) AS incoming(
        minute,
        service,
        level,
        count
      )
      ON CONFLICT (minute, service, level)
      DO UPDATE SET
        count =
          logs_minute_counts.count + EXCLUDED.count
    `;
    console.log("[debug] rollup flushed rows:", rows.length, rows);
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
