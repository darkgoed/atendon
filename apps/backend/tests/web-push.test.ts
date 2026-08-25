import { describe, expect, it, vi } from "vitest";
import type { WebPushSender } from "../src/modules/web-push/processor.js";
import { defaultPushPreferencesFor, privateWebPushPayload, WebPushProcessor } from "../src/modules/web-push/processor.js";
import type { PendingWebPushDelivery, WebPushRepository } from "../src/modules/web-push/repository.js";

function delivery(): PendingWebPushDelivery {
  return {
    outboxId: "10000000-0000-4000-8000-000000000001",
    tenantId: "10000000-0000-4000-8000-000000000002",
    eventType: "assigned_message",
    urgency: "normal",
    targetPath: "/conversas?id=10000000-0000-4000-8000-000000000003",
    subscriptionId: "10000000-0000-4000-8000-000000000004",
    endpoint: "https://push.example/subscription",
    p256dh: "public-key-material",
    auth: "auth-secret"
  };
}

function repositoryMock(deliveries = [delivery()]) {
  return {
    prepareDeliveries: vi.fn().mockResolvedValue(deliveries),
    finishOutbox: vi.fn().mockResolvedValue(undefined),
    deliveryStillAuthorized: vi.fn().mockResolvedValue(true),
    markDeliverySent: vi.fn().mockResolvedValue(undefined),
    removeExpiredSubscription: vi.fn().mockResolvedValue(undefined),
    markDeliveryRetry: vi.fn().mockResolvedValue(undefined)
  };
}

describe("Web Push delivery", () => {
  it("builds a lock-screen-safe payload without contact or message content", () => {
    const payload = privateWebPushPayload(delivery());
    expect(JSON.parse(payload)).toEqual({
      notification_id: delivery().outboxId,
      type: "assigned_message",
      urgency: "normal",
      path: delivery().targetPath
    });
    expect(Object.keys(JSON.parse(payload))).not.toEqual(expect.arrayContaining([
      "name", "phone", "contact_name", "contact_phone", "preview", "message", "content"
    ]));
  });

  it("marks a successful delivery and completes the durable outbox", async () => {
    const repository = repositoryMock();
    const sender: WebPushSender = { send: vi.fn().mockResolvedValue(undefined) };
    const processor = new WebPushProcessor(repository as unknown as WebPushRepository, sender);

    await expect(processor.process(delivery().tenantId, delivery().outboxId)).resolves.toBe("sent");
    expect(repository.prepareDeliveries).toHaveBeenCalledWith(delivery().tenantId, delivery().outboxId);
    expect(sender.send).toHaveBeenCalledOnce();
    expect(repository.markDeliverySent).toHaveBeenCalledWith(delivery().outboxId, delivery().subscriptionId);
    expect(repository.finishOutbox).toHaveBeenCalledWith(delivery().outboxId);
  });

  it.each([404, 410])("removes a subscription rejected with %s without retrying it", async (statusCode) => {
    const repository = repositoryMock();
    const sender: WebPushSender = { send: vi.fn().mockRejectedValue({ statusCode }) };
    const processor = new WebPushProcessor(repository as unknown as WebPushRepository, sender);

    await expect(processor.process(delivery().tenantId, delivery().outboxId)).resolves.toBe("expired");
    expect(repository.removeExpiredSubscription).toHaveBeenCalledWith(delivery().subscriptionId);
    expect(repository.markDeliveryRetry).not.toHaveBeenCalled();
  });

  it("does not send a delivery whose workspace access was revoked after preparation", async () => {
    const repository = repositoryMock();
    repository.deliveryStillAuthorized.mockResolvedValue(false);
    const sender: WebPushSender = { send: vi.fn().mockResolvedValue(undefined) };
    const processor = new WebPushProcessor(repository as unknown as WebPushRepository, sender);

    await expect(processor.process(delivery().tenantId, delivery().outboxId)).resolves.toBe("empty");
    expect(repository.deliveryStillAuthorized).toHaveBeenCalledWith(
      delivery().tenantId,
      delivery().outboxId,
      delivery().subscriptionId
    );
    expect(sender.send).not.toHaveBeenCalled();
    expect(repository.finishOutbox).toHaveBeenCalledWith(delivery().outboxId);
  });

  it("preserves transient failures for BullMQ retry and marks the final attempt terminal", async () => {
    const repository = repositoryMock();
    const sender: WebPushSender = { send: vi.fn().mockRejectedValue(new Error("push provider unavailable")) };
    const processor = new WebPushProcessor(repository as unknown as WebPushRepository, sender);

    await expect(processor.process(delivery().tenantId, delivery().outboxId, true)).rejects.toThrow("push provider unavailable");
    expect(repository.markDeliveryRetry).toHaveBeenCalledOnce();
    expect(repository.finishOutbox).toHaveBeenCalledWith(delivery().outboxId, "push provider unavailable", true);
  });

  it("enables operational categories by default and keeps other updates opt-in", () => {
    expect(defaultPushPreferencesFor("assigned_message")).toBe(true);
    expect(defaultPushPreferencesFor("appointment_reminder")).toBe(true);
    expect(defaultPushPreferencesFor("critical_alert")).toBe(true);
    expect(defaultPushPreferencesFor("other")).toBe(false);
  });
});
