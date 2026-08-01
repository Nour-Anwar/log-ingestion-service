export interface AggregateParams {
  since: string;
  until: string;
  bucket: "1m" | "5m" | "1h" | "1d";
  groupBy?: "service" | "level";
}


const VALID_BUCKETS = [
  "1m",
  "5m",
  "1h",
  "1d",
];


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
    throw new Error(
      "since and until are required"
    );
  }



  if (
    isNaN(new Date(since).getTime()) ||
    isNaN(new Date(until).getTime())
  ) {
    throw new Error(
      "invalid timestamp"
    );
  }



  if (
    new Date(until) <= new Date(since)
  ) {
    throw new Error(
      "until must be after since"
    );
  }



  const bucket =
    typeof query.bucket === "string"
      ? query.bucket
      : undefined;



  if (
    !bucket ||
    !VALID_BUCKETS.includes(bucket)
  ) {
    throw new Error(
      "bucket must be one of 1m, 5m, 1h, 1d"
    );
  }



  const groupBy =
    query.group_by === "service" ||
    query.group_by === "level"
      ? query.group_by
      : undefined;



  return {
    since,
    until,
    bucket: bucket as AggregateParams["bucket"],
    groupBy,
  };
}