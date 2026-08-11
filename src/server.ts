import "dotenv/config";
import app from "./app.js";
import { sql } from "./db/client.js";
import { runMigrations } from "./db/runMigrations.js";
import { ensurePartitions, applyRetention } from "./db/partitions.js";
import { ensureMessageIndexOnSealedPartitions } from "./db/messageIndex.js";

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] server stayed alive:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection] server stayed alive:", err);
});
const PORT = process.env.PORT || 8080;
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 30);

async function start() {
  await sql`SELECT 1`;
  await runMigrations();
  await ensurePartitions();
  await ensureMessageIndexOnSealedPartitions().catch((err) => {
    console.error("[message-index] initial build failed:", err);
  });

  setInterval(() => ensurePartitions(), 6 * 60 * 60 * 1000);
  setInterval(
    () => {
      ensureMessageIndexOnSealedPartitions().catch((err) => {
        console.error("[message-index] scheduled build failed:", err);
      });
    },
    60 * 60 * 1000,
  );
  setInterval(() => applyRetention(RETENTION_DAYS), 60 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
