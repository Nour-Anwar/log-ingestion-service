-- idx_logs_ts_id: نمط الترقيم الافتراضي بدون فلتر
-- ORDER BY ts DESC, id DESC
CREATE INDEX IF NOT EXISTS idx_logs_ts_id
ON logs (ts DESC, id DESC);

-- idx_logs_service_ts_id: فلتر service= مع نفس ترتيب الترقيم
-- (يغطي أيضاً أي استعلام service+ts بدون حاجة لفهرس منفصل أقصر)
CREATE INDEX IF NOT EXISTS idx_logs_service_ts_id
ON logs (service, ts DESC, id DESC);

-- idx_logs_level_ts_id: فلتر level= مع نفس ترتيب الترقيم
-- (يغطي أيضاً أي استعلام level+ts بدون حاجة لفهرس منفصل أقصر)
CREATE INDEX IF NOT EXISTS idx_logs_level_ts_id
ON logs (level, ts DESC, id DESC);

-- idx_logs_service_level_ts: فلترة service= و level= مع بعض
CREATE INDEX IF NOT EXISTS idx_logs_service_level_ts
ON logs (service, level, ts DESC);