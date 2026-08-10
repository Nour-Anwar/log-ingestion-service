import autocannon from "autocannon";

const BATCH_SIZE = 500;
const DURATION_SECONDS = 30;
const CONNECTIONS = 20;

function buildBatch() {
  const logs = Array.from({ length: BATCH_SIZE }, (_, i) => ({
    timestamp: new Date().toISOString(),
    level: ["debug", "info", "warn", "error"][i % 4],
    service: ["checkout", "auth", "payments"][i % 3],
    message: `load test message ${i}`,
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
  });

  const requestsPerSec = result.requests.average;
  const logsPerSec = requestsPerSec * BATCH_SIZE;

  console.log(`\nConnections: ${CONNECTIONS}`);
  console.log(`Requests/sec: ${requestsPerSec.toFixed(1)}`);
  console.log(`Logs/sec:     ${logsPerSec.toFixed(0)}`);
  console.log(`Latency p50/p99: ${result.latency.p50}ms / ${result.latency.p99}ms`);
  console.log(`Errors: ${result.errors}, Timeouts: ${result.timeouts}`);
}

run();
