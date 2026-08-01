import "dotenv/config";
import app from "./app.js";
import { sql } from "./db/client.js";
import { runMigrations } from "./db/runMigrations.js";
import { ensurePartitions, applyRetention } from "./db/partitions.js";

const PORT = process.env.PORT || 8080;
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 30);

async function start() {
  await sql`SELECT 1`;
  await runMigrations();
  await ensurePartitions();

  setInterval(() => ensurePartitions(), 6 * 60 * 60 * 1000); // كل 6 ساعات
  setInterval(() => applyRetention(RETENTION_DAYS), 60 * 60 * 1000); // كل ساعة

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});