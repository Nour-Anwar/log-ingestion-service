import express from "express";
import { ingestLogs } from "./logs/ingest.js";
import { listLogs } from "./logs/list.js";
import { aggregateLogs } from "./logs/aggregate.js";


const app = express();


app.use(
  express.json({
    limit:"10mb"
  })
);



app.get("/health", (_req,res)=>{

  res.status(200).json({
    status:"ok"
  });

});



app.post("/logs", ingestLogs);

app.get("/logs", listLogs);

app.get(
  "/logs/aggregate",
  aggregateLogs
);



export default app;