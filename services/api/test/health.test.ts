import { describe, it, expect, afterAll } from "vitest";
import { buildApp } from "../src/index.js";

describe("GET /health", () => {
  const app = buildApp();

  afterAll(async () => {
    await app.close();
  });

  it("returns 200 with an ok status", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("api");
    expect(typeof body.timestamp).toBe("string");
  });
});

describe("GET /api/v1", () => {
  const app = buildApp();
  afterAll(async () => {
    await app.close();
  });

  it("identifies itself as a prototype with no real money", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toMatch(/simulated/i);
  });
});
