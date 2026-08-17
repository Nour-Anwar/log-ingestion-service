const VALID_LEVELS = ["debug", "info", "warn", "error"];
const VALID_BUCKETS = ["1m", "5m", "1h", "1d"];

export interface AggregateParams {
  since: string;
  until: string;
  bucket: "1m" | "5m" | "1h" | "1d";
  groupBy?: "service" | "level";
  service?: string;
  level?: string;
  q?: string;
  attrs: Record<string, string>;
}

export function parseAggregateQuery(
  query: Record<string, unknown>
): AggregateParams {
  const since =
    typeof query.since === "string"
      ? query.since
      : undefined;

  const until =
    typeof query.until === "string"
      ? query.until
      : undefined;

  if (!since || !until) {
    throw new Error("since and until are required");
  }

  if (
    isNaN(new Date(since).getTime()) ||
    isNaN(new Date(until).getTime())
  ) {
    throw new Error("invalid timestamp");
  }

  // نسمح بـ since === until (مدى فارغ صالح، بيرجع buckets فارغة)،
  // نرفض بس until < since
  if (new Date(until) < new Date(since)) {
    throw new Error("until must not be earlier than since");
  }

  const bucket =
    typeof query.bucket === "string"
      ? query.bucket
      : undefined;

  if (!bucket || !VALID_BUCKETS.includes(bucket)) {
    throw new Error(
      "bucket must be one of 1m, 5m, 1h, 1d"
    );
  }

  // group_by غير الصالح لازم يرجّع 400 بدل ما يتجاهَل بصمت
  const rawGroupBy = query.group_by;
  let groupBy: "service" | "level" | undefined;

  if (rawGroupBy !== undefined) {
    if (rawGroupBy === "service" || rawGroupBy === "level") {
      groupBy = rawGroupBy;
    } else {
      throw new Error(
        `invalid group_by: '${String(rawGroupBy)}', must be 'service' or 'level'`,
      );
    }
  }

  const service =
    typeof query.service === "string"
      ? query.service
      : undefined;

  const level =
    typeof query.level === "string"
      ? query.level
      : undefined;

  if (level && !VALID_LEVELS.includes(level)) {
    throw new Error(`invalid level: '${level}'`);
  }

  const q =
    typeof query.q === "string"
      ? query.q
      : undefined;

  const attrs: Record<string, string> = {};

  for (const [key, value] of Object.entries(query)) {
    if (
      key.startsWith("attr.") &&
      typeof value === "string"
    ) {
      attrs[key.slice(5)] = value;
    }
  }

  return {
    since,
    until,
    bucket: bucket as AggregateParams["bucket"],
    groupBy,
    service,
    level,
    q,
    attrs,
  };
}