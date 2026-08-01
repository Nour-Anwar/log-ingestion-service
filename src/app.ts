import express from "express";
import { ingestLogs } from "./logs/ingest.js";

const app = express();

app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
  });
});

app.post("/logs", ingestLogs);

export default app;