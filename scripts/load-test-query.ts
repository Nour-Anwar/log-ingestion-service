import autocannon from "autocannon";

const SERVICES = ["checkout", "auth", "payments", "search", "shipping"];
const LEVELS = ["debug", "info", "warn", "error"];
const WORDS = ["declined", "timeout", "retry", "success", "failed"];

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Random window inside the last 24h so `since`/`until` vary per request
// (avoids the 200ms aggregate cache and exercises different rollup/live ranges).
function randomWindow(): { since: string; until: string } {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const start = now - dayMs + Math.floor(Math.random() * dayMs);
  const spanMs = [5 * 60_000, 60 * 60_000, 6 * 60 * 60_000][
    Math.floor(Math.random() * 3)
  ];
  return {
    since: new Date(start).toISOString(),
    until: new Date(Math.min(start + spanMs, now)).toISOString(),
  };
}

function randomLogsUrl(): string {
  const { since, until } = randomWindow();
  const params = new URLSearchParams({ since, until, limit: "100" });

  // Mix filter combinations so all logs indexes get exercised, not just one.
  const kind = Math.random();
  if (kind < 0.25) {
    params.set("service", randomItem(SERVICES));
  } else if (kind < 0.5) {
    params.set("level", randomItem(LEVELS));
  } else if (kind < 0.7) {
    params.set("service", randomItem(SERVICES));
    params.set("level", randomItem(LEVELS));
  } else if (kind < 0.85) {
    params.set("q", randomItem(WORDS));
  } else {
    params.set("attr.user_id", String(Math.floor(Math.random() * 1000)));
  }

  return `/logs?${params.toString()}`;
}

function randomAggregateUrl(): string {
  const { since, until } = randomWindow();
  const params = new URLSearchParams({
    since,
    until,
    bucket: randomItem(["1m", "5m", "1h"]),
  });
  if (Math.random() < 0.5) {
    params.set("group_by", randomItem(["service", "level"]));
  }
  return `/logs/aggregate?${params.toString()}`;
}

async function run() {
  console.log("=== GET /logs (varied filters, cache-avoiding) ===");
  const logsResult = await autocannon({
    url: "http://localhost:8080",
    connections: 10,
    duration: 30,
    timeout: 10,
    requests: [
      {
        setupRequest: (req) => ({ ...req, path: randomLogsUrl() }),
      },
    ],
  });
  console.log(`p50: ${logsResult.latency.p50}ms, p95: ${logsResult.latency.p97_5}ms, p99: ${logsResult.latency.p99}ms`);
  console.log(`Requests completed: ${logsResult.requests.total}`);
  console.log(`Errors: ${logsResult.errors}, Timeouts: ${logsResult.timeouts}`);
  if (logsResult.errors > 0) console.log("Non-2xx codes:", logsResult.non2xx);

  console.log("\n=== GET /logs/aggregate (varied windows/buckets) ===");
  const aggResult = await autocannon({
    url: "http://localhost:8080",
    connections: 10,
    duration: 30,
    timeout: 10,
    requests: [
      {
        setupRequest: (req) => ({ ...req, path: randomAggregateUrl() }),
      },
    ],
  });
  console.log(`p50: ${aggResult.latency.p50}ms, p95: ${aggResult.latency.p97_5}ms, p99: ${aggResult.latency.p99}ms`);
  console.log(`Requests completed: ${aggResult.requests.total}`);
  console.log(`Errors: ${aggResult.errors}, Timeouts: ${aggResult.timeouts}`);
  if (aggResult.errors > 0) console.log("Non-2xx codes:", aggResult.non2xx);
}

run();