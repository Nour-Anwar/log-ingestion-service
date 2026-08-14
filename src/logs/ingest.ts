import type { Request, Response } from "express";
import { validateLogEntry } from "./validate.js";
import { enqueueLogs } from "../db/writeBuffer.js";

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
  const ts = entry.parsedTimestamp.toISOString();

  return (
    csvField(ts) +
    "," +
    csvField(entry.level) +
    "," +
    csvField(entry.service) +
    "," +
    csvField(entry.message) +
    "," +
    csvField(JSON.stringify(entry.attributes)) +
    "\n"
  );
}

export async function ingestLogs(
  req: Request,
  res: Response,
) {
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
    const raw = body.logs[index];

    const result = validateLogEntry(raw);

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
    await enqueueLogs(
      acceptedRows,
      acceptedEntries,
    );
  } catch (error) {
    console.error(
      "[ingest] flush failed:",
      error,
    );

    return res.status(500).json({
      error: "failed to write logs, please retry",
    });
  }

  return res.status(200).json({
    accepted: acceptedRows.length,
    rejected,
  });
}
