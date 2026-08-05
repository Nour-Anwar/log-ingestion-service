import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app.js";
import { resetLogs } from "./helpers.js";

describe("GET /logs/aggregate", () => {
  beforeEach(resetLogs);

  it("requires since and until", async () => {
    const res = await request(app).get("/logs/aggregate?bucket=1h");
    expect(res.status).toBe(400);
  });

  it("rejects invalid bucket", async () => {
    const res = await request(app).get(
      "/logs/aggregate?since=2026-08-01T00:00:00Z&until=2026-08-02T00:00:00Z&bucket=2h"
    );
    expect(res.status).toBe(400);
  });

 it("returns group: null when group_by is absent", async () => {
  await request(app)
    .post("/logs")
    .send({
      logs: [
        {
          timestamp: new Date().toISOString(),
          level: "error",
          service: "checkout",
          message: "x",
        },
      ],
    });

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const res = await request(app).get(
    `/logs/aggregate?since=${since}&until=${until}&bucket=1d`
  );
  expect(res.status).toBe(200);
  expect(res.body.buckets[0].group).toBeNull();
});
});