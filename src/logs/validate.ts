import { z } from "zod";

const attributeValue = z.union([z.string(), z.number(), z.boolean()]);

export const logEntrySchema = z.object({
  timestamp: z.string().refine((v) => {
    const d = new Date(v);
    if (isNaN(d.getTime())) return false;
    return d.getTime() <= Date.now() + 5 * 60 * 1000;
  }, "invalid or too-future timestamp"),
  level: z.enum(["debug", "info", "warn", "error"]),
  service: z.string().min(1),
  message: z.string().min(1),
  attributes: z.record(z.string(), attributeValue).optional().default({}),
});

export type LogEntry = z.infer<typeof logEntrySchema>;