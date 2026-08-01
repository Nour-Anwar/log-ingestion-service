import { sql } from "../src/db/client.js";

export async function resetLogs() {
  await sql`TRUNCATE TABLE logs`;
}