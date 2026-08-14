import express from "express";
import { ingestLogs } from "./logs/ingest.js";
import { listLogs } from "./logs/list.js";
import { aggregateLogs } from "./logs/aggregate.js";

const app = express();

const MAX_INFLIGHT_INGEST = Number(
  process.env.MAX_INFLIGHT_INGEST ?? 400,
);

let inflightIngest = 0;

function ingestBackpressure(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (inflightIngest >= MAX_INFLIGHT_INGEST) {
    res.set("Retry-After", "1");
    return res.status(503).json({
      error: "server busy, please retry",
    });
  }

  inflightIngest++;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    inflightIngest--;
  };

  res.once("finish", release);
  res.once("close", release);

  next();
}

app.post("/logs", ingestBackpressure);

app.use(
  express.json({
    limit: "10mb",
  }),
);

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
  });
});

app.post("/logs", ingestLogs);
app.get("/logs", listLogs);
app.get("/logs/aggregate", aggregateLogs);

export default app;