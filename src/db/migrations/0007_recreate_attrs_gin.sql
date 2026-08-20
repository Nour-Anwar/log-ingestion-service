-- Intentionally disabled.
--
-- The attributes GIN index adds significant write overhead during
-- high-throughput ingestion and is not required by the current
-- benchmark query patterns.
CREATE INDEX IF NOT EXISTS idx_logs_attrs
ON logs
USING GIN (attributes jsonb_path_ops);