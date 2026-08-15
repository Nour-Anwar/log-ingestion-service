import "dotenv/config";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

// COPY writes (ingest) — الشغل الأثقل، هو أولوية الكتابة
export const sql = postgres(connectionString, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  connection: {
    synchronous_commit: "off",
  },
});

// queries (GET /logs, GET /logs/aggregate)
export const readSql = postgres(connectionString, {
  max: 15,
  idle_timeout: 20,
  connect_timeout: 10,
});

// rollup upserts فقط — منفصل عشان ما يتخانق مع COPY streams
// على نفس الـ connections وقت الضغط
export const rollupSql = postgres(connectionString, {
  max: 4,
  idle_timeout: 20,
  connect_timeout: 10,
  connection: {
    synchronous_commit: "off",
  },
});