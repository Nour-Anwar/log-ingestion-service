-- idx_logs_level_ts (0000_init.sql) was superseded by
-- idx_logs_service_level_ts and idx_logs_ts_id from 0003.
-- Never dropped — costing insert overhead with no query benefit.
DROP INDEX IF EXISTS idx_logs_level_ts;
