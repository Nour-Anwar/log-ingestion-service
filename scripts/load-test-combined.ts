import autocannon from "autocannon";

const DURATION_SECONDS =120;
const BATCH_SIZE = 500;
const CONNECTIONS = 30;
function buildBatch() {
  const logs = Array.from({ length: BATCH_SIZE }, (_, i) => ({
    timestamp: new Date().toISOString(),
    level: ["debug", "info", "warn", "error"][i % 4],
    service: ["checkout", "auth", "payments"][i % 3],
    message: `combined load test ${i}`,
    attributes: { user_id: String(i) },
  }));
  return JSON.stringify({ logs });
}

async function runIngestion() {
  return autocannon({
    url: "http://localhost:8080/logs",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: buildBatch(),
    connections: CONNECTIONS,
    duration: DURATION_SECONDS,
    timeout: 10,
  });
}

async function runAggregateProbes() {
  const latencies: number[] = [];
  const since = encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  const iterations = DURATION_SECONDS; // طلب واحد كل ثانية، بالضبط زي متطلب الـ spec
  for (let i = 0; i < iterations; i++) {
    const until = encodeURIComponent(new Date().toISOString());
    const start = Date.now();
    try {
      const res = await fetch(
        `http://localhost:8080/logs/aggregate?since=${since}&until=${until}&bucket=1h&group_by=service`
      );
      await res.json();
      latencies.push(Date.now() - start);
    } catch (err) {
      console.error(`[aggregate probe ${i}] failed:`, err);
      latencies.push(-1); // فشل، مش latency حقيقي
    }
    await new Promise((r) => setTimeout(r, 1000)); // كل ثانية بالضبط
  }
  return latencies;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function run() {
  console.log(`Running ingestion (${CONNECTIONS} connections) and aggregate probes (1/sec) concurrently for ${DURATION_SECONDS}s...\n`);

  // الاثنين بالتوازي — هذا هو المهم
  const [ingestResult, aggLatencies] = await Promise.all([
    runIngestion(),
    runAggregateProbes(),
  ]);

  const validLatencies = aggLatencies.filter((l) => l >= 0).sort((a, b) => a - b);
  const failed = aggLatencies.filter((l) => l < 0).length;

  console.log("=== Ingestion (while aggregate polling ran concurrently) ===");
  console.log(`Requests/sec: ${ingestResult.requests.average.toFixed(1)}`);
  console.log(`Logs/sec:     ${(ingestResult.requests.average * BATCH_SIZE).toFixed(0)}`);
  console.log(`Errors: ${ingestResult.errors}, Timeouts: ${ingestResult.timeouts}`);

  console.log("\n=== Aggregate (1 request/sec, while ingestion ran concurrently) ===");
  console.log(`Requests sent: ${aggLatencies.length}, Failed: ${failed}`);
  console.log(`p50: ${percentile(validLatencies, 50)}ms`);
  console.log(`p95: ${percentile(validLatencies, 95)}ms`);
  console.log(`p99: ${percentile(validLatencies, 99)}ms`);
  console.log(`max: ${validLatencies[validLatencies.length - 1]}ms`);

  const p95 = percentile(validLatencies, 95);
  console.log(`\n${p95 < 1000 ? "✅ PASS" : "❌ FAIL"}: aggregate p95 ${p95 < 1000 ? "under" : "over"} 1000ms while ingestion active`);
}

run();