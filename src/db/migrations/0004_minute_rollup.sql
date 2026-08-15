CREATE TABLE IF NOT EXISTS logs_minute_counts (
    minute   TIMESTAMPTZ NOT NULL,
    service  TEXT NOT NULL,
    level    log_level NOT NULL,
    count    BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (minute, service, level)
);

ALTER TABLE logs_minute_counts SET UNLOGGED;
