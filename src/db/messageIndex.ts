import { sql } from "./client.js";

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export async function ensureMessageIndexesOnSealedPartitions() {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const partitions = await sql<{ tablename: string }[]>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename ~ '^logs_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
  `;

  for (const { tablename } of partitions) {
    const match = tablename.match(
      /^logs_(\d{4})_(\d{2})_(\d{2})$/
    );

    if (!match) continue;

    const [, year, month, day] = match;
    const partitionDate = new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day))
    );

    // Never build the expensive trigram index on today's active partition.
    if (partitionDate >= today) continue;

    const indexName = `idx_${tablename}_message_trgm`;

    const result = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = ${indexName}
      ) AS exists
    `;

    if (result[0]?.exists) continue;

    console.log(
      `[message-index] creating ${indexName} on ${tablename}`
    );

    await sql.unsafe(`
      CREATE INDEX CONCURRENTLY ${quoteIdentifier(indexName)}
      ON ${quoteIdentifier(tablename)}
      USING GIN (message gin_trgm_ops)
    `);

    console.log(
      `[message-index] created ${indexName}`
    );
  }
}
