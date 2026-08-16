-- logs_minute_counts بتتحدث بشكل مكثف جدًا عبر ON CONFLICT DO UPDATE
-- (upsert لكل دقيقة/service/level كل ~150ms أثناء الحمل)، فهي المصدر
-- الأكبر لـ dead tuples، وautovacuum الافتراضي بيستنى نسبة تراكم
-- كبيرة (20%) قبل ما يشتغل، فبيصير VACUUM ضخم بلحظة واحدة يزاحم
-- الكتابة الحية. هون منخفض العتبة، فيشتغل بدفعات أصغر وأكثر تكرارًا.
ALTER TABLE logs_minute_counts SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_cost_delay = 10
);
