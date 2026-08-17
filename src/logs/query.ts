import { readSql as sql } from "../db/client.js";

export interface LogQueryParams {
  service?: string;
  level?: string;
  since?: string;
  until?: string;
  attrs: Record<string, string>;
  q?: string;
  limit: number;
  cursor?: {
    ts: string;
    id: number;
  };
}

interface LogRowDb {
  id: string;
  ts: string;
  level: string;
  service: string;
  message: string;
  attributes: Record<string, unknown>;
}

function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

export async function queryLogs(params: LogQueryParams) {
  const conditions = [];

  if (params.service) {
    conditions.push(sql`service = ${params.service}`);
  }

  if (params.level) {
    conditions.push(sql`level = ${params.level}::log_level`);
  }

  if (params.since) {
    conditions.push(sql`ts >= ${params.since}`);
  }

  if (params.until) {
    conditions.push(sql`ts < ${params.until}`);
  }

  if (params.q) {
    const q = escapeLike(params.q);
    conditions.push(sql`message ILIKE ${"%" + q + "%"} ESCAPE '\\'`);
  }

  const hasAttrFilter = Object.keys(params.attrs).length > 0;

  for (const [key, value] of Object.entries(params.attrs)) {
    conditions.push(sql`attributes @> ${sql.json({ [key]: value })}`);
  }

  if (params.cursor) {
    conditions.push(sql`(ts, id) < (${params.cursor.ts}, ${params.cursor.id})`);
  }

  const whereClause =
    conditions.length > 0
      ? sql`WHERE ${conditions.reduce(
          (acc, condition) => sql`${acc} AND ${condition}`,
        )}`
      : sql``;

  // فلترة الـ attributes نادرة وموزّعة بشكل عشوائي عبر الزمن، فخطة
  // الـ planner الطبيعية (Merge Append عبر فهرس ts لكل partition)
  // بتمسح آلاف الصفوف بكل partition قبل ما تلاقي تطابق. لف الاستعلام
  // بـ CTE MATERIALIZED بيجبر الـ planner يستخدم فهرس GIN على
  // attributes لكل partition لحاله (سريع جداً)، وبعدين يرتب النتيجة
  // الصغيرة المجمّعة — قياس فعلي: 1421ms → 3ms.
  const rows = hasAttrFilter
    ? await sql<LogRowDb[]>`
        WITH matches AS MATERIALIZED (
          SELECT id, ts, level, service, message, attributes
          FROM logs
          ${whereClause}
        )
        SELECT * FROM matches
        ORDER BY ts DESC, id DESC
        LIMIT ${params.limit + 1}
      `
    : await sql<LogRowDb[]>`
        SELECT
          id,
          ts,
          level,
          service,
          message,
          attributes
        FROM logs
        ${whereClause}
        ORDER BY ts DESC, id DESC
        LIMIT ${params.limit + 1}
      `;

  const hasMore = rows.length > params.limit;

  const logs = hasMore ? rows.slice(0, params.limit) : rows;

  const nextCursor = hasMore
    ? encodeCursor(logs[logs.length - 1].ts, logs[logs.length - 1].id)
    : null;

  return {
    logs: logs.map((log) => ({
      id: log.id,
      timestamp: log.ts,
      level: log.level,
      service: log.service,
      message: log.message,
      attributes: log.attributes,
    })),
    nextCursor,
  };
}
export function encodeCursor(ts: string, id: string | number) {
  return Buffer.from(
    JSON.stringify({
      ts,
      id: Number(id),
    }),
  ).toString("base64url");
}

export function decodeCursor(cursor: string) {
  const data = JSON.parse(Buffer.from(cursor, "base64url").toString());

  if (
    typeof data.ts !== "string" ||
    typeof data.id !== "number" ||
    !Number.isSafeInteger(data.id)
  ) {
    throw new Error("invalid cursor");
  }

  return data;
}
