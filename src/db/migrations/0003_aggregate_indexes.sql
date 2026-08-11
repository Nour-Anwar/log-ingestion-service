CREATE INDEX IF NOT EXISTS idx_logs_ts_service_level
ON logs (ts, service, level);
