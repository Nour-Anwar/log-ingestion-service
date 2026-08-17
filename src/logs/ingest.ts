import type { Request, Response } from "express";
import { validateLogEntry } from "./validate.js";
import { enqueueLogs, BackpressureError } from "../db/writeBuffer.js";

function csvField(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function buildCsvRow(entry: {
  parsedTimestamp: Date;
  level: string;
  service: string;
  message: string;
  attributes: Record<string, unknown>;
}): string {
  return (
    [
      csvField(entry.parsedTimestamp.toISOString()),
      csvField(entry.level),
      csvField(entry.service),
      csvField(entry.message),
      csvField(JSON.stringify(entry.attributes)),
    ].join(",") + "\n"
  );
}

export async function ingestLogs(req: Request, res: Response) {
  const body = req.body;

  if (!body || !Array.isArray(body.logs)) {
    return res.status(400).json({
      error: "expected { logs: [...] }",
    });
  }

  const acceptedRows: string[] = [];
  const acceptedEntries: {
    timestamp: string;
    level: string;
    service: string;
  }[] = [];

  const rejected: {
    index: number;
    reason: string;
  }[] = [];

  for (let index = 0; index < body.logs.length; index++) {
    const result = validateLogEntry(body.logs[index]);

    if (!result.success || !result.data) {
      rejected.push({
        index,
        reason: result.error ?? "invalid entry",
      });

      continue;
    }

    const entry = result.data;

    acceptedRows.push(buildCsvRow(entry));

    acceptedEntries.push({
      timestamp: entry.timestamp,
      level: entry.level,
      service: entry.service,
    });
  }

  if (acceptedRows.length === 0) {
    return res.status(400).json({
      accepted: 0,
      rejected,
    });
  }

  try {
    await enqueueLogs(acceptedRows, acceptedEntries);
  } catch (err) {
    if (err instanceof BackpressureError) {
      res.setHeader("Retry-After", "1");

      return res.status(503).json({
        error: "service overloaded, retry shortly",
      });
    }

    console.error("[ingest] flush failed:", err);

    return res.status(500).json({
      error: "failed to write logs, please retry",
    });
  }

  return res.status(200).json({
    accepted: acceptedRows.length,
    rejected,
  });
}