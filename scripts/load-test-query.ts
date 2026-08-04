import autocannon from "autocannon";

async function run() {
  const since = encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  const until = encodeURIComponent(new Date().toISOString());

  const result = await autocannon({
    url: `http://localhost:8080/logs/aggregate?since=${since}&until=${until}&bucket=1h&group_by=service`,
    method: "GET",
    connections: 1,
    duration: 30,
    timeout: 10,
  });

  console.log(`p50: ${result.latency.p50}ms, p99: ${result.latency.p99}ms`);
  console.log(`Requests completed: ${result.requests.total}`);
  console.log(`Errors: ${result.errors}, Timeouts: ${result.timeouts}`);

  if (result.errors > 0) {
    console.log("Non-2xx codes:", result.non2xx);
  }
}

run();