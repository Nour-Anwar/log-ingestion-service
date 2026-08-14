-- idx_logs_service_ts (service, ts DESC) is a strict prefix of
-- idx_logs_service_ts_id (service, ts DESC, id DESC) — any query
-- planner choice that would use the former can use the latter with
-- no meaningful cost difference. Dropping the redundant one to cut
-- per-insert index-maintenance cost.
DROP INDEX IF EXISTS idx_logs_service_ts;
