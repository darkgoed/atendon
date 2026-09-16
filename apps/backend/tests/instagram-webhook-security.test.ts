import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  normalizeInstagramWebhook,
  verifyInstagramSignature
} from "../src/modules/instagram/provider.js";
import { handleInstagramWebhook } from "../src/modules/instagram/webhook.js";
import type { NormalizedInstagramEvent } from "../src/modules/instagram/types.js";

const NOW = Date.parse("2026-09-15T00:00:00.000Z");
const TIMESTAMP = NOW - 1_000;

function signature(raw: Buffer, secret = "app-secret"): string {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

function messaging(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    sender: { id: "igsid-1" },
    recipient: { id: "account-1" },
    timestamp: TIMESTAMP,
    ...payload
  };
}

describe("Instagram webhook normalization", () => {
  it("uses kind-specific stable dedupe IDs for message, read, and reactions", () => {
    const events = normalizeInstagramWebhook({
      object: "instagram",
      entry: [{
        id: "account-1",
        time: TIMESTAMP,
        messaging: [
          messaging({ message: { mid: "shared-mid", text: "hello" } }),
          messaging({ read: { mid: "shared-mid" } }),
          messaging({
            reaction: {
              mid: "shared-mid",
              action: "react",
              reaction: "love",
              emoji: "❤️"
            }
          }),
          messaging({
            reaction: {
              mid: "shared-mid",
              action: "unreact"
            }
          })
        ]
      }]
    }, NOW);

    expect(events.map((event) => event.eventId)).toEqual([
      "message:shared-mid",
      "read:shared-mid",
      `reaction:shared-mid:react:love:❤️:${TIMESTAMP}`,
      `reaction:shared-mid:unreact:::${TIMESTAMP}`
    ]);
    expect(new Set(events.map((event) => event.eventId))).toHaveLength(4);

    const replay = normalizeInstagramWebhook({
      object: "instagram",
      entry: [{
        id: "account-1",
        messaging: [messaging({
          reaction: {
            mid: "shared-mid",
            action: "react",
            reaction: "love",
            emoji: "❤️"
          }
        })]
      }]
    }, NOW);
    expect(replay[0]?.eventId).toBe(events[2]?.eventId);
  });

  it("detects a business-sender echo even when is_echo is omitted", () => {
    const events = normalizeInstagramWebhook({
      object: "instagram",
      entry: [{
        id: "account-1",
        messaging: [{
          sender: { id: "account-1" },
          recipient: { id: "igsid-1" },
          timestamp: TIMESTAMP,
          message: { mid: "echo-mid", text: "sent by business" }
        }]
      }]
    }, NOW);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventId: "message:echo-mid",
      accountId: "account-1",
      providerUserId: "igsid-1",
      isEcho: true
    });
  });

  it.each([
    ["wrong object", { object: "page", entry: [] }],
    ["inbound recipient mismatch", {
      object: "instagram",
      entry: [{
        id: "account-1",
        messaging: [{
          sender: { id: "igsid-1" },
          recipient: { id: "other-account" },
          timestamp: TIMESTAMP,
          message: { mid: "mid-1", text: "hello" }
        }]
      }]
    }],
    ["echo sender mismatch", {
      object: "instagram",
      entry: [{
        id: "account-1",
        messaging: [{
          sender: { id: "igsid-1" },
          recipient: { id: "account-1" },
          timestamp: TIMESTAMP,
          message: { mid: "mid-1", is_echo: true }
        }]
      }]
    }]
  ])("drops %s instead of routing an unverified event", (_label, payload) => {
    expect(normalizeInstagramWebhook(payload, NOW)).toEqual([]);
  });

  it("clamps a future provider timestamp so it cannot extend the messaging window", () => {
    const events = normalizeInstagramWebhook({
      object: "instagram",
      entry: [{
        id: "account-1",
        messaging: [{
          sender: { id: "igsid-1" },
          recipient: { id: "account-1" },
          timestamp: NOW + 300_000,
          message: { mid: "mid-1", text: "hello" }
        }]
      }]
    }, NOW);

    expect(events).toHaveLength(1);
    expect(events[0]?.timestamp).toEqual(new Date(NOW));
  });

  it("rejects malformed HMAC encodings and an empty secret", () => {
    const raw = Buffer.from("{}");
    expect(verifyInstagramSignature(raw, signature(raw), "app-secret")).toBe(true);
    expect(verifyInstagramSignature(raw, "sha256=zz", "app-secret")).toBe(false);
    expect(verifyInstagramSignature(raw, `sha256=${"a".repeat(64)}extra`, "app-secret"))
      .toBe(false);
    expect(verifyInstagramSignature(raw, signature(raw, ""), "")).toBe(false);
  });
});

describe("handleInstagramWebhook", () => {
  it("verifies and persists the explicit raw Buffer before acknowledging", async () => {
    const receivedAt = Date.now() - 1_000;
    const raw = Buffer.from(JSON.stringify({
      object: "instagram",
      entry: [{
        id: "account-1",
        messaging: [{
          sender: { id: "igsid-1" },
          recipient: { id: "account-1" },
          timestamp: receivedAt,
          message: { mid: "mid-1", text: "hello" }
        }]
      }]
    }, null, 2));
    const persistEvent = vi.fn<(tenantId: string, sessionId: string, event: NormalizedInstagramEvent, bytes: Buffer) => Promise<unknown>>()
      .mockResolvedValue({ duplicate: false });
    const app = Fastify();
    app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });
    app.post("/webhook", async (request, reply) => handleInstagramWebhook(
      request,
      reply,
      {
        repository: { persistEvent },
        appSecret: "app-secret",
        resolveAccount: vi.fn().mockResolvedValue({
          tenantId: "tenant-1",
          sessionId: "connection-uuid"
        }),
        rawBody: request.body as Buffer
      }
    ));

    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature(raw)
      },
      payload: raw
    });

    expect(response.statusCode).toBe(200);
    expect(persistEvent).toHaveBeenCalledTimes(1);
    expect(persistEvent.mock.calls[0]?.[3].equals(raw)).toBe(true);
    await app.close();
  });

  it("never acknowledges a persistence failure", async () => {
    const receivedAt = Date.now() - 1_000;
    const raw = Buffer.from(JSON.stringify({
      object: "instagram",
      entry: [{
        id: "account-1",
        messaging: [{
          sender: { id: "igsid-1" },
          recipient: { id: "account-1" },
          timestamp: receivedAt,
          message: { mid: "mid-1", text: "hello" }
        }]
      }]
    }));
    const app = Fastify();
    app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });
    app.post("/webhook", async (request, reply) => handleInstagramWebhook(
      request,
      reply,
      {
        repository: {
          persistEvent: vi.fn().mockRejectedValue(new Error("database unavailable"))
        },
        appSecret: "app-secret",
        resolveAccount: vi.fn().mockResolvedValue({
          tenantId: "tenant-1",
          sessionId: "connection-uuid"
        }),
        rawBody: request.body as Buffer
      }
    ));

    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature(raw)
      },
      payload: raw
    });

    expect(response.statusCode).toBe(500);
    await app.close();
  });
});
