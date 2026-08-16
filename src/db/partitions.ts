import { sql } from "./client.js";
import { ensureMessageIndexes } from "./messageIndex.js";

function partitionName(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `logs_${y}_${m}_${d}`;
}

function startOfDayUTC(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function ensurePartitions(daysBack = 1, daysForward = 3) {
  const today = startOfDayUTC(new Date());

  for (let offset = -daysBack; offset <= daysForward; offset++) {
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() + offset);

    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);

    const name = partitionName(start);

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${name}
      PARTITION OF logs
      FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}')
    `);

    // partitions حديثة (خصوصًا partition اليوم) بتستقبل ملايين
    // الصفوف بفترة قصيرة أثناء اختبارات الحمل. autovacuum
    // الافتراضي (scale factor 0.2) بينتظر تراكم 20% تغيير قبل ما
    // يشتغل — رقم ضخم على جدول بالملايين، وهاد بيخلي الـ visibility
    // map قديمة ويحوّل Index Only Scans إلى heap fetches إضافية
    // تحت الحمل (تأكدنا من هيك فعليًا بـ EXPLAIN ANALYZE: 625K heap
    // fetches على partition فيها 5.7M صف). تعطيل autovacuum بالكامل
    // بيزيد هاي المشكلة، مش يحلها — لهيك نضبطه بعنف بدل ما نعطله.
    await sql.unsafe(`
      ALTER TABLE ${name} SET (
        autovacuum_vacuum_scale_factor = 0.01,
        autovacuum_vacuum_cost_delay = 0,
        autovacuum_analyze_scale_factor = 0.02
      )
    `);
  }

  await ensureMessageIndexes();
}

export async function applyRetention(retentionDays: number) {
  const cutoff = startOfDayUTC(new Date());
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);

  const partitions = await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename ~ '^logs_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
  `;

  for (const { tablename } of partitions) {
    const [, y, m, d] = tablename.match(/^logs_(\d{4})_(\d{2})_(\d{2})$/) ?? [];
    if (!y) continue;

    const partitionDate = new Date(
      Date.UTC(Number(y), Number(m) - 1, Number(d)),
    );

    if (partitionDate < cutoff) {
      await sql.unsafe(`DROP TABLE IF EXISTS ${tablename}`);
      console.log(`[retention] dropped partition ${tablename}`);
    }
  }
}