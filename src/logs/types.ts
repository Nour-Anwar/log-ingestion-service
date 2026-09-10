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
