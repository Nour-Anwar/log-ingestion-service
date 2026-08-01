import { decodeCursor } from "./query.js";

const LEVELS = ["debug", "info", "warn", "error"];

export interface ParsedQuery {
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

export function parseLogQuery(query: Record<string, unknown>): ParsedQuery {
  const service = typeof query.service === "string" ? query.service : undefined;

  const level = typeof query.level === "string" ? query.level : undefined;

  if (level && !LEVELS.includes(level)) {
    throw new Error("invalid level");
  }

  const since = typeof query.since === "string" ? query.since : undefined;

  const until = typeof query.until === "string" ? query.until : undefined;

  if (since && isNaN(new Date(since).getTime())) {
    throw new Error("invalid since timestamp");
  }

  if (until && isNaN(new Date(until).getTime())) {
    throw new Error("invalid until timestamp");
  }

  if (since && until && new Date(until) < new Date(since)) {
    throw new Error("until must not be earlier than since");
  }
  const q = typeof query.q === "string" ? query.q : undefined;

  let limit = 100;

  if (query.limit !== undefined) {
    const value = Number(query.limit);

    if (!Number.isInteger(value) || value < 1 || value > 1000) {
      throw new Error("limit must be between 1 and 1000");
    }

    limit = value;
  }

  let cursor;

  if (typeof query.cursor === "string") {
    try {
      cursor = decodeCursor(query.cursor);
    } catch {
      throw new Error("invalid cursor");
    }
  }

  const attrs: Record<string, string> = {};

  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith("attr.") && typeof value === "string") {
      attrs[key.substring(5)] = value;
    }
  }

  return {
    service,
    level,
    since,
    until,
    attrs,
    q,
    limit,
    cursor,
  };
}
