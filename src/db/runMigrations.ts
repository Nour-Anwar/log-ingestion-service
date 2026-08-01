import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { sql } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations() {
  const migrationsDir = path.join(__dirname, "migrations");
  const file = path.join(migrationsDir, "0000_init.sql");

  const alreadyExists = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'logs'
    ) AS exists
  `;

  if (alreadyExists[0]?.exists) {
    console.log("[migrations] already applied, skipping");
    return;
  }

  const script = readFileSync(file, "utf-8");
  await sql.unsafe(script);
  console.log("[migrations] applied 0000_init.sql");
}