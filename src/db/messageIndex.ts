import { sql } from "./client.js";

export async function ensureMessageIndexOnSealedPartitions() {
  const today = new Date();
  const todayName = `logs_${today.getUTCFullYear()}_${String(today.getUTCMonth() + 1).padStart(2, "0")}_${String(today.getUTCDate()).padStart(2, "0")}`;

  const partitions = await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename ~ '^logs_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
      AND tablename != ${todayName}
  `;

  for (const { tablename } of partitions) {
    const indexName = `${tablename}_message_trgm_idx`;
    const exists = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = ${indexName}
      ) AS exists
    `;
    if (exists[0]?.exists) continue;

    console.log(`[message-index] building trigram index on sealed partition ${tablename}...`);
    await sql.unsafe(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName}
      ON ${tablename} USING GIN (message gin_trgm_ops)
    `);
    console.log(`[message-index] done: ${indexName}`);
  }
}
