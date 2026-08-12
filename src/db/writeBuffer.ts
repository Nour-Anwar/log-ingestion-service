import { sql } from "./client.js";
import { queueRollupCounts } from "./rollup.js";
 
const FLUSH_INTERVAL_MS = 25;
const MAX_BATCH_SIZE = 20000; // safety valve: flush early if a batch gets huge
 
// كم COPY ممكن يشتغلوا بنفس اللحظة. جرّب 2 / 3 / 4 وشوف وين ألذ throughput
// بدون ما تزيد الـ context-switching على الـ 1 CPU المخصص لـ Postgres.
const MAX_CONCURRENT_FLUSHES = 3;
 
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
  return { csvRows: [], entries: [], resolve, reject, promise };
}
 
let current = newBatch();
let timer: ReturnType<typeof setTimeout> | null = null;
const queue: Batch[] = [];
let inFlight = 0;
 
function scheduleFlush() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    rotate();
  }, FLUSH_INTERVAL_MS);
}
 
function rotate() {
  if (current.csvRows.length === 0) return;
  queue.push(current);
  current = newBatch();
  pump();
}
 
// بدل الـ single-file drain loop: منسمح لعدة flushes يشتغلوا بالتوازي
// (لحد MAX_CONCURRENT_FLUSHES) بدل ما نستنى batch يخلص بالكامل قبل ما نبلّش التالي.
function pump() {
  while (inFlight < MAX_CONCURRENT_FLUSHES && queue.length > 0) {
    const batch = queue.shift()!;
    inFlight++;
    flushBatch(batch)
      .then(() => batch.resolve())
      .catch((err) => batch.reject(err))
      .finally(() => {
        inFlight--;
        pump(); // فضي مكان؟ خود batch تاني من الطابور فوراً
      });
  }
}
 
async function flushBatch(batch: Batch) {
  const writable = await sql`
    COPY logs (ts, level, service, message, attributes)
    FROM STDIN WITH (FORMAT csv)
  `.writable();
 
  await new Promise<void>((resolve, reject) => {
    writable.on("error", reject);
    writable.on("finish", resolve);
    writable.write(batch.csvRows.join(""));
    writable.end();
  });
 
  // rollup فشله ما لازم يفشّل الـ ingest — وكمان ما لازم يأخّر الـ batch التالي.
  // queueRollupCounts بترجع فوراً (تجميع بالذاكرة فقط)، والكتابة الفعلية
  // لبوستغرس بتصير مجمّعة ومتسلسلة (upsert واحد بالـ flight بأي لحظة) —
  // شوف db/rollup.ts للتفاصيل وليش هاد كان لازم يتغيّر.
  queueRollupCounts(batch.entries);
}
 
/**
 * يضيف rows لل-batch الحالي ويرجع promise بتتحل لما الـ batch
 * (يلي هاد الـ row انضم إلها) ينكتب فعلياً بقاعدة البيانات.
 */
export function enqueueLogs(
  csvRows: string[],
  entries: AcceptedEntry[]
): Promise<void> {
  const batch = current;
  batch.csvRows.push(...csvRows);
  batch.entries.push(...entries);
 
  if (batch.csvRows.length >= MAX_BATCH_SIZE) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    rotate();
  } else {
    scheduleFlush();
  }
 
  return batch.promise;
}