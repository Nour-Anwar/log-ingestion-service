export interface LogEntry {
  timestamp: string;
  parsedTimestamp: Date;
  level: "debug" | "info" | "warn" | "error";
  service: string;
  message: string;
  attributes: Record<string, unknown>;
}

const VALID_LEVELS = new Set(["debug", "info", "warn", "error"]);
const FIVE_MIN_MS = 5 * 60 * 1000;

export interface ValidationResult {
  success: boolean;
  data?: LogEntry;
  error?: string;
}

export function validateLogEntry(raw: unknown): ValidationResult {
  if (typeof raw !== "object" || raw === null) {
    return { success: false, error: "entry must be an object" };
  }

  const entry = raw as Record<string, unknown>;

  // timestamp
  if (typeof entry.timestamp !== "string") {
    return { success: false, error: "timestamp is required" };
  }
  const parsedTimestamp = new Date(entry.timestamp);
  const ts = parsedTimestamp.getTime();
  if (Number.isNaN(ts)) {
    return { success: false, error: "invalid or too-future timestamp" };
  }
  if (ts > Date.now() + FIVE_MIN_MS) {
    return { success: false, error: "invalid or too-future timestamp" };
  }

  // level
  if (typeof entry.level !== "string" || !VALID_LEVELS.has(entry.level)) {
    return {
      success: false,
      error: `invalid level: '${String(entry.level)}'`,
    };
  }

  // service
  if (typeof entry.service !== "string" || entry.service.length === 0) {
    return { success: false, error: "service is required" };
  }

  // message
  if (typeof entry.message !== "string" || entry.message.length === 0) {
    return { success: false, error: "message is required" };
  }

  // attributes (optional, flat, string|number|boolean values only)
  let attributes: Record<string, unknown> = {};
  if (entry.attributes !== undefined) {
    if (
      typeof entry.attributes !== "object" ||
      entry.attributes === null ||
      Array.isArray(entry.attributes)
    ) {
      return { success: false, error: "attributes must be a flat object" };
    }
    const attrs = entry.attributes as Record<string, unknown>;
    for (const key in attrs) {
      const v = attrs[key];
      const t = typeof v;
      if (t !== "string" && t !== "number" && t !== "boolean") {
        return {
          success: false,
          error: `attribute '${key}' must be string, number, or boolean`,
        };
      }
    }
    attributes = attrs;
  }

  return {
    success: true,
    data: {
      timestamp: entry.timestamp,
      parsedTimestamp,
      level: entry.level as LogEntry["level"],
      service: entry.service,
      message: entry.message,
      attributes,
    },
  };
}
