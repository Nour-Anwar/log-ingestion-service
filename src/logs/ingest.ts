import type { Request, Response } from "express";
import { sql } from "../db/client.js";
import { logEntrySchema } from "./validate.js";
import { upsertHourlyCounts } from "../db/rollup.js";

function csvField(value: string): string {
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
  return (
    [
      csvField(ts),
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
    return res.status(400).json({ error: "expected { logs: [...] }" });
  }

  const acceptedRows: string[] = [];
  const acceptedEntries: { timestamp: string; level: string; service: string }[] = [];
  const rejected: { index: number; reason: string }[] = [];

  body.logs.forEach((raw: unknown, index: number) => {
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
  });

  if (acceptedRows.length === 0) {
    return res.status(400).json({ accepted: 0, rejected });
  }

  try {
    const writable = await sql`
      COPY logs (ts, level, service, message, attributes)
      FROM STDIN WITH (FORMAT csv)
    `.writable();

    await new Promise<void>((resolve, reject) => {
      writable.on("error", reject);
      writable.on("finish", resolve);
      writable.write(acceptedRows.join(""));
      writable.end();
    });

    await upsertHourlyCounts(acceptedEntries);
  } catch (err) {
    console.error("[ingest] write failed:", err);
    return res.status(500).json({ error: "failed to write logs, please retry" });
  }

  res.status(200).json({ accepted: acceptedRows.length, rejected });
}