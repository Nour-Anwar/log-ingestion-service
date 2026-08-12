// scripts/load-test-realistic.ts
//
// يحاكي سيناريو "Load" الحقيقي من الـ grader:
//   15000 logs/s لمدة 120 ثانية (open-loop، مش closed-loop زي autocannon)
//   وبعدها فحص eventual consistency: هل البيانات صارت queryable خلال 30 ثانية؟
//
// شغّليه بـ: npx tsx scripts/load-test-realistic.ts
 
const BASE_URL = "http://localhost:8080";
 
const TARGET_LOGS_PER_SEC = 15000;
const BATCH_SIZE = 500; // logs بكل POST request
const REQUESTS_PER_SEC = TARGET_LOGS_PER_SEC / BATCH_SIZE; // 30 request/sec
const DURATION_SECONDS = 120;
const CONSISTENCY_DRAIN_SECONDS = 30;
const CONSISTENCY_POLL_INTERVAL_MS = 2000;
 
const SERVICES = ["checkout", "auth", "payments", "search", "notifications"];
const LEVELS = ["debug", "info", "warn", "error"];
 
let sent = 0;
let accepted = 0;
let rejected = 0;
let httpErrors = 0;
let inFlight = 0;
const latencies: number[] = [];
 
function buildBatch() {
  const now = new Date();
  const logs = Array.from({ length: BATCH_SIZE }, (_, i) => ({
    timestamp: now.toISOString(), // وقت حقيقي لحظة الإرسال، مش وقت ثابت
    level: LEVELS[i % LEVELS.length],
    service: SERVICES[i % SERVICES.length],
    message: `realistic load test message ${sent}-${i}`,
    attributes: { user_id: String(Math.floor(Math.random() * 10000)) },
  }));
  return JSON.stringify({ logs });
}
 
async function fireOne() {
  sent++;
  inFlight++;
  const start = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: buildBatch(),
    });
    latencies.push(Date.now() - start);
 
    if (res.status === 200) {
      const body = (await res.json()) as {
        accepted: number;
        rejected: unknown[];
      };
      accepted += body.accepted ?? 0;
      rejected += body.rejected?.length ?? 0;
    } else {
      httpErrors++;
    }
  } catch (err) {
    httpErrors++;
    latencies.push(Date.now() - start);
  } finally {
    inFlight--;
  }
}
 
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return -1;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
 
function printProgress(elapsedSec: number) {
  const rate = accepted / Math.max(elapsedSec, 1);
  console.log(
    `[t=${elapsedSec}s] sent=${sent} accepted=${accepted} rejected=${rejected} httpErrors=${httpErrors} inFlight=${inFlight} avgRate=${rate.toFixed(0)}logs/s`
  );
}
 
async function runLoadPhase(): Promise<{ testStart: string; testEnd: string }> {
  console.log(
    `\n=== المرحلة 1: حمل ${TARGET_LOGS_PER_SEC} logs/s لمدة ${DURATION_SECONDS} ثانية (open-loop) ===\n`
  );
 
  const testStart = new Date().toISOString();
  const intervalMs = 1000 / REQUESTS_PER_SEC;
  const endAt = Date.now() + DURATION_SECONDS * 1000;
 
  const progressTimer = setInterval(() => {
    printProgress(Math.round((Date.now() - Date.parse(testStart)) / 1000));
  }, 10_000);
 
  const pending: Promise<void>[] = [];
 
  while (Date.now() < endAt) {
    const tickStart = Date.now();
    pending.push(fireOne());
    const elapsed = Date.now() - tickStart;
    const wait = intervalMs - elapsed;
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    // ما منستنى كل طلب يخلص (هذا هو معنى open-loop) —
    // بس منمنع الذاكرة تنفجر لو صار backlog ضخم فعلاً
    if (pending.length > 20000) {
      await Promise.race(pending);
    }
  }
 
  clearInterval(progressTimer);
  console.log("\nخلصت مرحلة الإرسال، عم ننتظر الطلبات المعلّقة (inFlight)...");
  await Promise.allSettled(pending);
 
  const testEnd = new Date().toISOString();
  return { testStart, testEnd };
}
 
async function checkConsistency(testStart: string, testEnd: string) {
  console.log(
    `\n=== المرحلة 2: فحص eventual consistency (حتى ${CONSISTENCY_DRAIN_SECONDS} ثانية) ===\n`
  );
  console.log(`Accepted logs خلال الاختبار: ${accepted}`);
 
  const deadline = Date.now() + CONSISTENCY_DRAIN_SECONDS * 1000;
  let lastVisible = -1;
 
  while (Date.now() < deadline) {
    const iterStart = Date.now();
    try {
      const url = `${BASE_URL}/logs/aggregate?since=${encodeURIComponent(
        testStart
      )}&until=${encodeURIComponent(testEnd)}&bucket=1d`;
      const res = await fetch(url);
      const body = (await res.json()) as {
        buckets: { count: number }[];
      };
      const visible = body.buckets.reduce((sum, b) => sum + b.count, 0);
      const elapsedSec = ((Date.now() - Date.parse(testEnd)) / 1000).toFixed(1);
 
      console.log(
        `  [+${elapsedSec}s بعد نهاية الحمل] visible=${visible} / accepted=${accepted} (${(
          (visible / Math.max(accepted, 1)) *
          100
        ).toFixed(1)}%)`
      );
 
      lastVisible = visible;
 
      if (visible >= accepted) {
        console.log("\n✅ كل الـ logs صارت queryable.");
        break;
      }
    } catch (err) {
      console.log(`  فشل فحص consistency: ${err}`);
    }
 
    const wait = CONSISTENCY_POLL_INTERVAL_MS - (Date.now() - iterStart);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
 
  return lastVisible;
}
 
async function run() {
  const { testStart, testEnd } = await runLoadPhase();
 
  const sorted = [...latencies].sort((a, b) => a - b);
  const elapsedTotalSec = (Date.parse(testEnd) - Date.parse(testStart)) / 1000;
 
  console.log("\n=== نتائج مرحلة الحمل ===");
  console.log(`Requests sent:     ${sent}`);
  console.log(`Accepted logs:     ${accepted}`);
  console.log(`Rejected logs:     ${rejected}`);
  console.log(`HTTP errors:       ${httpErrors}`);
  console.log(`Achieved logs/s:   ${(accepted / elapsedTotalSec).toFixed(0)} (target: ${TARGET_LOGS_PER_SEC})`);
  console.log(`Latency p50/p95/p99: ${percentile(sorted, 50)}ms / ${percentile(sorted, 95)}ms / ${percentile(sorted, 99)}ms`);
 
  const lastVisible = await checkConsistency(testStart, testEnd);
 
  console.log("\n=== الخلاصة ===");
  console.log(
    `Eventual consistency: ${lastVisible >= accepted ? "✅ PASSED" : `❌ FAILED (${lastVisible}/${accepted} visible)`}`
  );
}
 
run().catch((err) => {
  console.error(err);
  process.exit(1);
});
 