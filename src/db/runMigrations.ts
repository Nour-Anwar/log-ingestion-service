import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { sql } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  await sql`SELECT pg_advisory_lock(${MIGRATIONS_LOCK_KEY})`;

  try {
    await applyIfMissing("logs", "0000_init.sql");
    await applyAlways("0001_core_indexes.sql");
    await applyIfMissing("logs_minute_counts", "0002_minute_rollup.sql");
  } finally {
    await sql`SELECT pg_advisory_unlock(${MIGRATIONS_LOCK_KEY})`;
  }
}
