import "dotenv/config";
import app from "./app.js";
import { sql } from "./db/client.js";
import { runMigrations } from "./db/runMigrations.js";

const PORT = process.env.PORT || 8080;

async function start() {
  await sql`SELECT 1`;
  await runMigrations();

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});