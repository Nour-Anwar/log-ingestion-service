import "dotenv/config";
import postgres from "postgres";

const primaryUrl = process.env.DATABASE_URL;
const replicaUrl = process.env.READ_DATABASE_URL;

if (!primaryUrl) {
  throw new Error("DATABASE_URL is not set");
}

// COPY writes
export const sql = postgres(primaryUrl, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  connection: {
    synchronous_commit: "off",
  },
});

// Read queries
export const readSql = postgres(replicaUrl ?? primaryUrl, {
  max: 15,
  idle_timeout: 20,
  connect_timeout: 5,
});

// Rollup writes
export const rollupSql = postgres(primaryUrl, {
  max: 4,
  idle_timeout: 20,
  connect_timeout: 10,
  connection: {
    synchronous_commit: "off",
  },
});