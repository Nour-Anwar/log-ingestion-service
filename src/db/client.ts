import "dotenv/config";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

export const sql = postgres(connectionString, {
  max: 6,
  idle_timeout: 20,
  connect_timeout: 10,
  connection: {
    synchronous_commit: "off",
  },
});

export const readSql = postgres(connectionString, {
  max: 15,
});