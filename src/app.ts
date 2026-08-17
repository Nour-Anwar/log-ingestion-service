import express from "express";
import { ingestLogs } from "./logs/ingest.js";
import { listLogs } from "./logs/list.js";
import { aggregateLogs } from "./logs/aggregate.js";

const app = express();

app.use(
  express.json({
    limit: "10mb",
  }),
);

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
  });
});

app.post("/logs", ingestLogs);
app.get("/logs", listLogs);
app.get("/logs/aggregate", aggregateLogs);

// يمسك SyntaxError من express.json() (JSON غير صالح) ويرجع
// 400 بصيغة JSON متسقة مع باقي استجابات الخطأ، بدل صفحة
// Express الافتراضية HTML
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (err instanceof SyntaxError && "body" in err) {
      return res.status(400).json({ error: "malformed JSON" });
    }
    next(err);
  },
);

export default app;