CREATE INDEX IF NOT EXISTS idx_logs_ts_id
ON logs (ts DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_logs_service_ts_id
ON logs (service, ts DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_logs_level_ts_id
ON logs (level, ts DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_logs_service_level_ts
ON logs (service, level, ts DESC);