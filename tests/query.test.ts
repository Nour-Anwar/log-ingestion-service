import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app.js";
import { resetLogs } from "./helpers.js";

async function seed(overrides = {}) {
  return request(app)
    .post("/logs")
    .send({
      logs: [
        {
          timestamp: new Date().toISOString(),
          level: "error",
          service: "checkout",
          message: "payment declined",
          attributes: { user_id: "42" },
          ...overrides,
        },
      ],
    });
}

describe("GET /logs", () => {
  beforeEach(resetLogs);

  it("returns timestamp field (not ts)", async () => {
    await seed();
    const res = await request(app).get("/logs?limit=5");
    expect(res.status).toBe(200);
    expect(res.body.logs[0]).toHaveProperty("timestamp");
    expect(res.body.logs[0]).not.toHaveProperty("ts");
  });

  it("filters by service", async () => {
    await seed({ service: "checkout" });
    await seed({ service: "auth" });
    const res = await request(app).get("/logs?service=auth");
    expect(res.body.logs.every((l: any) => l.service === "auth")).toBe(true);
  });

  it("filters by attr.<key>", async () => {
    await seed({ attributes: { user_id: "99" } });
    const res = await request(app).get("/logs?attr.user_id=99");
    expect(res.body.logs.length).toBeGreaterThan(0);
  });

  it("returns 400 for non-numeric limit", async () => {
    const res = await request(app).get("/logs?limit=abc");
    expect(res.status).toBe(400);
  });

  it("returns 400 when until is before since", async () => {
    const res = await request(app).get(
      "/logs?since=2026-08-01T12:00:00Z&until=2026-08-01T10:00:00Z"
    );
    expect(res.status).toBe(400);
  });

  it("empty result set returns empty array, not error", async () => {
    const res = await request(app).get("/logs?service=nonexistent-service");
    expect(res.status).toBe(200);
    expect(res.body.logs).toEqual([]);
    expect(res.body.next_cursor).toBeNull();
  });
});