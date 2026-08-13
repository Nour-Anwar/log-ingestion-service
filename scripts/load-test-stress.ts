import autocannon from "autocannon";

const TARGET_LOGS_PER_SEC = 15000;
const BATCH_SIZE = 250;
const DURATION_SECONDS = 90;
const CONNECTIONS = 35; // واقعي جدًا مع max_connections=40-50

// نحسب الـ requests/sec المطلوبة تقريبيًا
const REQUESTS_PER_SEC = Math.ceil(TARGET_LOGS_PER_SEC / BATCH_SIZE);

function buildBatch() {
  const now = Date.now();
  const logs = Array.from({ length: BATCH_SIZE }, (_, i) => ({
    timestamp: new Date(now - (i % 1000)).toISOString(),
    level: ["debug", "info", "warn", "error"][i % 4],
    service: ["checkout", "auth", "payments", "inventory"][i % 4],
    message: `loadgen message ${i} - payment processing`,
    attributes: {
      user_id: String(1000 + (i % 500)),
      region: ["eu-west", "us-east", "ap-south"][i % 3],
      request_id: `req-${now}-${i}`,
    },
  }));
  return JSON.stringify({ logs });
}

async function run() {
  console.log("=== Company-like Load Test ===");
  console.log(`Target:           ~${TARGET_LOGS_PER_SEC} logs/sec`);
  console.log(`Batch size:       ${BATCH_SIZE}`);
  console.log(`Connections:      ${CONNECTIONS}`);
  console.log(`Duration:         ${DURATION_SECONDS}s`);
  console.log("--------------------------------");

  const result = await autocannon({
    url: "http://localhost:8080/logs",
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: buildBatch(),
    connections: CONNECTIONS,
    duration: DURATION_SECONDS,
    timeout: 20,
    pipelining: 1,
    amount: undefined, // unlimited during duration
  });

  const logsPerSec = result.requests.average * BATCH_SIZE;

  console.log("\n=== Results ===");
  console.log(`Requests/sec:     ${result.requests.average.toFixed(1)}`);
  console.log(`Logs/sec:         ${logsPerSec.toFixed(0)}`);
  console.log(`Latency p50:      ${result.latency.p50} ms`);
  console.log(`Latency p95:      ${result.latency.p95} ms`);
  console.log(`Latency p99:      ${result.latency.p99} ms`);
  console.log(`2xx:              ${result["2xx"] ?? 0}`);
  console.log(`Non-2xx:          ${result.non2xx ?? 0}`);
  console.log(`Timeouts:         ${result.timeouts}`);
  console.log(`Errors:           ${result.errors}`);

  console.log("\n=== Assessment ===");
  if (logsPerSec >= 15000 && result.timeouts === 0 && (result.non2xx ?? 0) === 0) {
    console.log("✅ Excellent — meets company target with zero errors");
  } else if (logsPerSec >= 12000 && result.timeouts < 20) {
    console.log("🟡 Good — close to target");
  } else {
    console.log("⚠️ Needs improvement");
  }
}

run().catch(console.error);