import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const app = buildApp();

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("GET /events access checks", () => {
  it("rejects a cross-site origin before opening an SSE response", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/events",
      headers: {
        accept: "text/event-stream",
        origin: "https://attacker.invalid",
        "sec-fetch-site": "cross-site"
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.body).toContain("Origem não permitida");
  });

  it("rejects an unauthenticated same-site request before opening an SSE response", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/events",
      headers: { accept: "text/event-stream" }
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["content-type"]).not.toContain("text/event-stream");
  });
});

describe("operational metrics access", () => {
  it("keeps database and queue metrics root-only", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/root/operations/metrics"
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["content-type"]).toContain("application/json");
  });
});
