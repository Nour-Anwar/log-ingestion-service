-- idx_logs_attrs كان محذوف بافتراض إنه غير مستخدم (query كان
-- يستخدم ->> اللي ما بيدعمه GIN jsonb_path_ops). الحل الصحيح مش
-- حذف الفهرس، هو تصحيح شكل الاستعلام ليستخدم @> (containment)
-- بدل ->> — وهاد بيستفيد من نفس الفهرس مباشرة.
CREATE INDEX IF NOT EXISTS idx_logs_attrs
ON logs USING GIN (attributes jsonb_path_ops);
