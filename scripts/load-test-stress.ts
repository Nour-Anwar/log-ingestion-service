import autocannon from "autocannon";

const BATCH_SIZE = 100;
const DURATION_SECONDS = 30;
const CONNECTIONS = 1000;

function buildBatch() {
  const logs = Array.from({ length: BATCH_SIZE }, (_, i) => ({
    timestamp: new Date().toISOString(),
    level: ["debug", "info", "warn", "error"][i % 4],
    service: ["checkout", "auth", "payments"][i % 3],
    message: `stress test message ${i}`,
    attributes: { user_id: String(i) },
  }));
  return JSON.stringify({ logs });
}

async function run() {
  const result = await autocannon({
    url: "http://localhost:8080/logs",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: buildBatch(),
    connections: CONNECTIONS,
    duration: DURATION_SECONDS,
    timeout: 10,
    pipelining: 1,
  });

  console.log(`\nConnections: ${CONNECTIONS}`);
  console.log(`Requests/sec: ${result.requests.average.toFixed(1)}`);
  console.log(`Logs/sec:     ${(result.requests.average * BATCH_SIZE).toFixed(0)}`);
  console.log(`Latency p50/p99: ${result.latency.p50}ms / ${result.latency.p99}ms`);
  console.log(`2xx responses:   ${result["2xx"] ?? "n/a"}`);
  console.log(`Non-2xx (real server errors): ${result.non2xx ?? "n/a"}`);
  console.log(`Client-side timeouts (no response in time): ${result.timeouts}`);
  console.log(`Connection errors (refused/reset): ${result.errors}`);
}

run();