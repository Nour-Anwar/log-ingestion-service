CREATE TABLE IF NOT EXISTS logs_minute_counts (
    minute   TIMESTAMPTZ NOT NULL,
    service  TEXT NOT NULL,
    level    log_level NOT NULL,
    count    BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (minute, service, level)
);

ALTER TABLE logs_minute_counts SET UNLOGGED;

-- logs_minute_counts بتتحدث بشكل مكثف عبر ON CONFLICT DO UPDATE
-- (كل ~150ms أثناء الحمل)، فهي المصدر الأكبر لـ dead tuples.
-- تخفيض العتبة يخلي autovacuum يشتغل بدفعات أصغر وأكثر تكراراً
-- بدل VACUUM ضخم مرة وحدة يزاحم الكتابة الحية.
ALTER TABLE logs_minute_counts SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_cost_delay = 10
);