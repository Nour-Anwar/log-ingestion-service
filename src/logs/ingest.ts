import type { Request, Response } from "express";
import { sql } from "../db/client.js";
import { logEntrySchema } from "./validate.js";

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
  const rejected: { index: number; reason: string }[] = [];

  body.logs.forEach((raw: unknown, index: number) => {
    const result = logEntrySchema.safeParse(raw);
    if (result.success) {
      acceptedRows.push(buildCsvRow(result.data));
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

  const writable = await sql`
    COPY logs (ts, level, service, message, attributes)
    FROM STDIN WITH (FORMAT csv)
  `.writable();

  await new Promise<void>((resolve, reject) => {
    writable.on("error", reject);
    writable.on("finish", resolve);
    for (const row of acceptedRows) writable.write(row);
    writable.end();
  });

  res.status(200).json({ accepted: acceptedRows.length, rejected });
}