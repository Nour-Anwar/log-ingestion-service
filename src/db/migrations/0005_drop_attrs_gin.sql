-- idx_logs_attrs (GIN jsonb_path_ops) غير مستخدم: الكويري الحالي
-- بيعمل attributes ->> key = value (نص مقابل نص)، وهاد الشكل
-- ما بيستفيد من GIN jsonb_path_ops (بيدعم بس @>). الإندكس هاد
-- كان عبء كتابة صرف على كل insert.
DROP INDEX IF EXISTS idx_logs_attrs;
