import { sql } from "../src/db/client.js";
import { runMigrations } from "../src/db/runMigrations.js";
import { ensurePartitions } from "../src/db/partitions.js";

export async function setup() {
  await runMigrations();
  await ensurePartitions();
}

export async function teardown() {
  await sql.end();
}