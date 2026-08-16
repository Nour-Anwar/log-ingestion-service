import { sql } from "./client.js";

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// بيبني trgm index على partitions المختومة (سابقة، مش اليوم النشطة)
// فقط. partition اليوم بتستقبل ملايين الصفوف أثناء الحمل، فبناء
// GIN index عليها بيخلي كل insert يدفع تكلفة صيانة إضافية. بدون
// الفهرس على البيانات القديمة، أي بحث بـ q= على الأيام السابقة
// بيعمل seq scan كامل — لهيك منأجله بس عن اليوم الحالي.
export async function ensureMessageIndexes() {
  const partitions = await sql<{ tablename: string }[]>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename ~ '^logs_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
  `;

  for (const { tablename } of partitions) {
    const indexName = `idx_${tablename}_message_trgm`;

    const result = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = ${indexName}
      ) AS exists
    `;

    if (result[0]?.exists) continue;

    console.log(`[message-index] creating ${indexName} on ${tablename}`);
    await sql.unsafe(`
      CREATE INDEX CONCURRENTLY ${quoteIdentifier(indexName)}
      ON ${quoteIdentifier(tablename)}
      USING GIN (message gin_trgm_ops)
    `);
    console.log(`[message-index] created ${indexName}`);
  }
}