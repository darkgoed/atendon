import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { httpRateLimitKey, incrementLocalRateLimit } from "../src/security/http-rate-limit.js";

function request(input: {
  route: string;
  ip?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  body?: unknown;
}): FastifyRequest {
  return {
    ip: input.ip ?? "203.0.113.10",
    url: input.route,
    routeOptions: { url: input.route },
    headers: input.headers ?? {},
    cookies: input.cookies ?? {},
    body: input.body
  } as unknown as FastifyRequest;
}

describe("HTTP rate-limit keys", () => {
  it("keeps login attempts IP-scoped so rotating account names cannot evade the limit", () => {
    const first = request({ route: "/auth/login", body: { email: "first@example.test" } });
    const second = request({ route: "/auth/login", body: { email: "second@example.test" } });
    expect(httpRateLimitKey(first)).toBe(httpRateLimitKey(second));
  });

  it("does not let rotating unverified API credentials create fresh buckets", () => {
    const firstSecret = "atd_first-test-credential-value";
    const secondSecret = "atd_second-test-credential-value";
    const first = httpRateLimitKey(request({ route: "/categorias", headers: { "x-api-key": firstSecret } }));
    const second = httpRateLimitKey(request({ route: "/categorias", headers: { "x-api-key": secondSecret } }));
    expect(first).toBe(second);
    expect(first).not.toContain(firstSecret);
    expect(second).not.toContain(secondSecret);
  });

  it("does not trust unsigned session claims before authentication", () => {
    const first = httpRateLimitKey(request({
      route: "/usage/export",
      cookies: { atendon_session: "forged-session-one" }
    }));
    const second = httpRateLimitKey(request({
      route: "/usage/export",
      cookies: { atendon_session: "forged-session-two" }
    }));
    expect(first).toBe(second);
  });

  it("does not let rotating webhook instance names create fresh buckets", () => {
    const first = httpRateLimitKey(request({
      route: "/webhooks/evolution",
      body: { instance: "provider-instance-one" }
    }));
    const second = httpRateLimitKey(request({
      route: "/webhooks/evolution",
      body: { instance: "provider-instance-two" }
    }));
    expect(first).toBe(second);
  });

  it("keeps different trusted-proxy-resolved IPs in separate buckets", () => {
    const first = httpRateLimitKey(request({ route: "/auth/login", ip: "203.0.113.10" }));
    const second = httpRateLimitKey(request({ route: "/auth/login", ip: "203.0.113.11" }));
    expect(first).not.toBe(second);
  });
});

describe("local HTTP rate-limit fallback", () => {
  it("keeps enforcing the limit while Redis is unavailable", () => {
    const buckets = new Map();
    expect(incrementLocalRateLimit(buckets, "login:ip", 60_000, 2, false, false, 1_000))
      .toEqual({ current: 1, ttl: 60_000 });
    expect(incrementLocalRateLimit(buckets, "login:ip", 60_000, 2, false, false, 2_000))
      .toEqual({ current: 2, ttl: 59_000 });
    expect(incrementLocalRateLimit(buckets, "login:ip", 60_000, 2, false, false, 3_000).current)
      .toBe(3);
  });

  it("expires fallback buckets and preserves exponential backoff", () => {
    const buckets = new Map();
    incrementLocalRateLimit(buckets, "write:ip", 1_000, 1, false, true, 1_000);
    expect(incrementLocalRateLimit(buckets, "write:ip", 1_000, 1, false, true, 1_100))
      .toEqual({ current: 2, ttl: 1_000 });
    expect(incrementLocalRateLimit(buckets, "write:ip", 1_000, 1, false, true, 1_200))
      .toEqual({ current: 3, ttl: 2_000 });
    expect(incrementLocalRateLimit(buckets, "write:ip", 1_000, 1, false, true, 3_201))
      .toEqual({ current: 1, ttl: 1_000 });
  });

  it("bounds memory during a high-cardinality Redis outage", () => {
    const buckets = new Map();
    for (let index = 0; index < 10_001; index += 1) {
      incrementLocalRateLimit(buckets, `client-${index}`, 60_000, 10, false, false, 0);
    }

    expect(buckets.size).toBe(10_000);
    expect(buckets.has("client-0")).toBe(false);
    expect(buckets.has("client-10000")).toBe(true);
  });
});
