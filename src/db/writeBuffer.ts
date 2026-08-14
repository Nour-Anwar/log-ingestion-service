import { sql } from "./client.js";
import { queueRollupCounts } from "./rollup.js";

const FLUSH_INTERVAL_MS = 40;
const MAX_BATCH_SIZE = 10000;
const MAX_CONCURRENT_FLUSHES = 2;

interface AcceptedEntry {
  timestamp: string;
  level: string;
  service: string;
}

interface Batch {
  csvRows: string[];
  entries: AcceptedEntry[];
  resolve: () => void;
  reject: (err: unknown) => void;
  promise: Promise<void>;
}

function newBatch(): Batch {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;

  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return {
    csvRows: [],
    entries: [],
    resolve,
    reject,
    promise,
  };
}

let current = newBatch();
const queue: Batch[] = [];

let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = 0;

function scheduleFlush() {
  if (timer !== null) {
    return;
  }

  timer = setTimeout(() => {
    timer = null;
    rotate();
  }, FLUSH_INTERVAL_MS);
}

function rotate() {
  if (current.csvRows.length === 0) {
    return;
  }

  queue.push(current);
  current = newBatch();

  pump();
}

function pump() {
  while (
    inFlight < MAX_CONCURRENT_FLUSHES &&
    queue.length > 0
  ) {
    const batch = queue.shift()!;

    inFlight++;

    void flushBatch(batch)
      .then(() => {
        batch.resolve();
      })
      .catch((error) => {
        batch.reject(error);
      })
      .finally(() => {
        inFlight--;
        pump();
      });
  }
}

async function flushBatch(batch: Batch) {
  const writable = await sql`
    COPY logs (
      ts,
      level,
      service,
      message,
      attributes
    )
    FROM STDIN
    WITH (FORMAT csv)
  `.writable();

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const succeed = () => {
      if (settled) return;

      settled = true;
      resolve();
    };

    const fail = (error: unknown) => {
      if (settled) return;

      settled = true;
      reject(error);
    };

    writable.once("error", fail);
    writable.once("finish", succeed);

    writable.write(batch.csvRows.join(""));
    writable.end();
  });

  queueRollupCounts(batch.entries);
}

export function enqueueLogs(
  csvRows: string[],
  entries: AcceptedEntry[],
): Promise<void> {
  const batch = current;

  batch.csvRows.push(...csvRows);
  batch.entries.push(...entries);

  if (batch.csvRows.length >= MAX_BATCH_SIZE) {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }

    rotate();
  } else {
    scheduleFlush();
  }

  return batch.promise;
}
