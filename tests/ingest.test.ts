import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app.js";
import { resetLogs } from "./helpers.js";

const validLog = {
  timestamp: new Date().toISOString(),
  level: "error",
  service: "checkout",
  message: "payment declined",
  attributes: { user_id: "42" },
};

describe("POST /logs", () => {
  beforeEach(resetLogs);

  it("accepts a single valid log", async () => {
    const res = await request(app).post("/logs").send({ logs: [validLog] });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
    expect(res.body.rejected).toEqual([]);
  });

  it("rejects invalid level but keeps valid entries", async () => {
    const res = await request(app)
      .post("/logs")
      .send({ logs: [validLog, { ...validLog, level: "critical" }] });

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
    expect(res.body.rejected).toHaveLength(1);
    expect(res.body.rejected[0].index).toBe(1);
  });

  it("returns 400 when all entries are rejected", async () => {
    const res = await request(app)
      .post("/logs")
      .send({ logs: [{ ...validLog, level: "critical" }] });
    expect(res.status).toBe(400);
  });

  it("returns 400 on malformed body", async () => {
    const res = await request(app).post("/logs").send({ notLogs: [] });
    expect(res.status).toBe(400);
  });

  it("rejects timestamps more than 5 minutes in the future", async () => {
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const res = await request(app)
      .post("/logs")
      .send({ logs: [{ ...validLog, timestamp: future }] });
    expect(res.status).toBe(400);
  });

  it("rejects nested attributes", async () => {
    const res = await request(app)
      .post("/logs")
      .send({ logs: [{ ...validLog, attributes: { nested: { a: 1 } } }] });
    expect(res.status).toBe(400);
  });
});