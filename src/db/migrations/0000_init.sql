CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE log_level AS ENUM ('debug', 'info', 'warn', 'error');

CREATE TABLE logs (
    id          BIGINT GENERATED ALWAYS AS IDENTITY,
    ts          TIMESTAMPTZ NOT NULL,
    level       log_level NOT NULL,
    service     TEXT NOT NULL,
    message     TEXT NOT NULL,
    attributes  JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

CREATE INDEX idx_logs_service_ts ON logs (service, ts DESC);
CREATE INDEX idx_logs_level_ts   ON logs (level, ts DESC);
CREATE INDEX idx_logs_attrs      ON logs USING GIN (attributes);
CREATE INDEX idx_logs_message    ON logs USING GIN (message gin_trgm_ops);

CREATE TABLE logs_default PARTITION OF logs DEFAULT;