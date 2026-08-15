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

    const partitionDate = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));

    if (partitionDate < cutoff) {
      await sql.unsafe(`DROP TABLE IF EXISTS ${tablename}`);
      console.log(`[retention] dropped partition ${tablename}`);
    }
  }
}