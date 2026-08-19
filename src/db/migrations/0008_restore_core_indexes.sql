-- الفهارس دي كانت موجودة قديماً (0003_aggregate_indexes.sql الأصلية)
-- بس انحذفت بالغلط ضمن revert سابق، وضلت idx_logs_ts_service_level بس.
-- النتيجة: GET /logs بدون فلتر أو بفلتر service=/level= منفرد ما كان
-- عنده أي فهرس يخدمه، فكان يعمل full partition scan حتى بأبسط استعلام.
--
-- idx_logs_ts_id: يخدم نمط الترقيم الأساسي ORDER BY ts DESC, id DESC
-- (الأهم — هاد الناقص الرئيسي).
CREATE INDEX IF NOT EXISTS idx_logs_ts_id
ON logs (ts DESC, id DESC);

-- idx_logs_service_ts_id: service= مع نفس ترتيب الترقيم.
CREATE INDEX IF NOT EXISTS idx_logs_service_ts_id
ON logs (service, ts DESC, id DESC);

-- idx_logs_level_ts_id: level= مع نفس ترتيب الترقيم.
CREATE INDEX IF NOT EXISTS idx_logs_level_ts_id
ON logs (level, ts DESC, id DESC);

-- idx_logs_service_level_ts: فلترة service= و level= مع بعض.
CREATE INDEX IF NOT EXISTS idx_logs_service_level_ts
ON logs (service, level, ts DESC);