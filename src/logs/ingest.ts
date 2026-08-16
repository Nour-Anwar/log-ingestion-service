import type { Request, Response } from "express";
import { logEntrySchema } from "./validate.js";
import { enqueueLogs } from "../db/writeBuffer.js";

function csvField(value: string): string {
  // كتير حقول (level, service، وغالبًا message) ما فيها quotes إطلاقًا.
  // نتفادى replaceAll (بتعمل scan + allocation جديدة) لو مش لازمة.
  if (value.indexOf('"') === -1) {
    return `"${value}"`;
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function buildCsvRow(entry: {
  timestamp: string;
  level: string;
  service: string;
  message: string;
  attributes: Record<string, unknown>;
}): string {
  const ts = new Date(entry.timestamp).toISOString();
  // string concatenation مباشر بدل [..].join(",") — بيتفادى allocation
  // array وسيط لكل سطر.
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

export async function ingestLogs(req: Request, res: Response) {
  const body = req.body;

  if (!body || !Array.isArray(body.logs)) {
    return res.status(400).json({ error: "expected { logs: [...] }" });
  }

  const acceptedRows: string[] = [];
  const acceptedEntries: {
    timestamp: string;
    level: string;
    service: string;
  }[] = [];
  const rejected: { index: number; reason: string }[] = [];

  for (let index = 0; index < body.logs.length; index++) {
    const raw = body.logs[index];
    const result = logEntrySchema.safeParse(raw);
    if (result.success) {
      acceptedRows.push(buildCsvRow(result.data));
      acceptedEntries.push({
        timestamp: result.data.timestamp,
        level: result.data.level,
        service: result.data.service,
      });
    } else {
      rejected.push({
        index,
        reason: result.error.issues[0]?.message ?? "invalid entry",
      });
    }
  }

  if (acceptedRows.length === 0) {
    return res.status(400).json({ accepted: 0, rejected });
  }

  try {
    await enqueueLogs(acceptedRows, acceptedEntries);
  } catch (err) {
    console.error("[ingest] flush failed:", err);
    return res
      .status(500)
      .json({ error: "failed to write logs, please retry" });
  }

  res.status(200).json({
    accepted: acceptedRows.length,
    rejected,
  });
}