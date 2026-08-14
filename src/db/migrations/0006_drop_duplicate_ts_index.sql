-- idx_logs_ts (0002) and idx_logs_ts_id (0003) are identical:
-- both (ts DESC, id DESC). Keeping only idx_logs_ts_id.
DROP INDEX IF EXISTS idx_logs_ts;
