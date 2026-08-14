import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { sql } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// رقم عشوائي ثابت — أي قيمة bigint، المهم يكون نفس الرقم بكل استدعاء
// عشان القفل يشتغل صح بين عمليات مختلفة (container + test process).
const MIGRATIONS_LOCK_KEY = 727384910;

async function tableExists(name: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_name = ${name}
    ) AS exists
  `;
  return result[0]?.exists ?? false;
}

async function applyIfMissing(checkTable: string, file: string) {
  if (await tableExists(checkTable)) {
    console.log(`[migrations] ${file} already applied, skipping`);
    return;
  }
  const migrationsDir = path.join(__dirname, "migrations");
  const script = readFileSync(path.join(migrationsDir, file), "utf-8");
  await sql.unsafe(script);
  console.log(`[migrations] applied ${file}`);
}

async function applyAlways(file: string) {
  const migrationsDir = path.join(__dirname, "migrations");
  const script = readFileSync(path.join(migrationsDir, file), "utf-8");
  await sql.unsafe(script);
  console.log(`[migrations] ensured ${file}`);
}

export async function runMigrations() {
  // pg_advisory_lock بيوقف (blocks) لحد ما ياخد القفل — لو عملية تانية
  // ماسكاه، هاي العملية بتستنى بدل ما تصطدم فيها بسباق.
  await sql`SELECT pg_advisory_lock(${MIGRATIONS_LOCK_KEY})`;

  try {
    await applyIfMissing("logs", "0000_init.sql");
    await applyIfMissing("logs_hourly_counts", "0001_rollup.sql");
    await applyAlways("0002_ts_index.sql");
    await applyAlways("0003_aggregate_indexes.sql");
    await applyAlways("0004_unlogged_rollup.sql");
    await applyAlways("0005_drop_level_index.sql");
    await applyAlways("0006_drop_duplicate_ts_index.sql");
    await applyAlways("0007_drop_redundant_service_index.sql");
    await applyAlways("0008_drop_dead_level_index.sql");
    await applyAlways("0009_drop_parent_attrs_index.sql");
  } finally {
    await sql`SELECT pg_advisory_unlock(${MIGRATIONS_LOCK_KEY})`;
  }
}
