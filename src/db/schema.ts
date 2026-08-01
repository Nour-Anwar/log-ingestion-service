import {
  pgTable,
  bigint,
  timestamp,
  text,
  jsonb,
  pgEnum,
  primaryKey,
} from "drizzle-orm/pg-core";

export const logLevel = pgEnum("log_level", [
  "debug",
  "info",
  "warn",
  "error",
]);

export const logs = pgTable(
  "logs",
  {
    id: bigint("id", { mode: "number" }).notNull(),

    ts: timestamp("ts", {
      withTimezone: true,
    }).notNull(),

    level: logLevel("level").notNull(),

    service: text("service").notNull(),

    message: text("message").notNull(),

    attributes: jsonb("attributes")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.id, table.ts],
    }),
  }),
);