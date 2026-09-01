import webPush, { type PushSubscription, type RequestOptions } from "web-push";
import type { AppConfig } from "../../config.js";
import { WebPushRepository, type PendingWebPushDelivery, type WebPushEventType, type WebPushUrgency } from "./repository.js";
import { publicHttpsAgent } from "../../security/outbound-url.js";

const WEB_PUSH_REQUEST_TIMEOUT_MS = 10_000;
export interface WebPushSender {
  send(subscription: PushSubscription, payload: string, options: RequestOptions): Promise<void>;
}

function deliveryError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deliveryStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}

export function privateWebPushPayload(delivery: Pick<PendingWebPushDelivery, "outboxId" | "eventType" | "urgency" | "targetPath">) {
  return JSON.stringify({
    notification_id: delivery.outboxId,
    type: delivery.eventType,
    urgency: delivery.urgency,
    path: delivery.targetPath
  });
}

function requestUrgency(urgency: WebPushUrgency): RequestOptions["urgency"] {
  if (urgency === "critical") return "high";
  return urgency;
}

export class VapidWebPushSender implements WebPushSender {
  constructor(config: Pick<AppConfig, "WEB_PUSH_PUBLIC_KEY" | "WEB_PUSH_PRIVATE_KEY" | "WEB_PUSH_SUBJECT">) {
    if (!config.WEB_PUSH_PUBLIC_KEY || !config.WEB_PUSH_PRIVATE_KEY || !config.WEB_PUSH_SUBJECT) {
      throw new Error("VAPID não configurado");
    }
    webPush.setVapidDetails(config.WEB_PUSH_SUBJECT, config.WEB_PUSH_PUBLIC_KEY, config.WEB_PUSH_PRIVATE_KEY);
  }

  async send(subscription: PushSubscription, payload: string, options: RequestOptions): Promise<void> {
    await webPush.sendNotification(subscription, payload, options);
  }
}

export class WebPushProcessor {
  constructor(
    private readonly repository: WebPushRepository,
    private readonly sender: WebPushSender
  ) {}

  async process(tenantId: string, outboxId: string, terminalAttempt = false): Promise<"sent" | "expired" | "empty" | "skipped"> {
    const deliveries = await this.repository.prepareDeliveries(tenantId, outboxId);
    if (deliveries === null) return "skipped";
    if (deliveries.length === 0) {
      await this.repository.finishOutbox(outboxId);
      return "empty";
    }

    const retryErrors: string[] = [];
    let expired = 0;
    let attempted = 0;
    for (const delivery of deliveries) {
      if (!await this.repository.deliveryStillAuthorized(
        delivery.tenantId,
        delivery.outboxId,
        delivery.subscriptionId
      )) continue;
      attempted += 1;
      try {
        await this.sender.send({
          endpoint: delivery.endpoint,
          keys: { p256dh: delivery.p256dh, auth: delivery.auth }
        }, privateWebPushPayload(delivery), {
          TTL: delivery.eventType === "appointment_reminder" ? 15 * 60 : 60 * 60,
          urgency: requestUrgency(delivery.urgency),
          timeout: WEB_PUSH_REQUEST_TIMEOUT_MS,
          agent: publicHttpsAgent()        });
        await this.repository.markDeliverySent(delivery.outboxId, delivery.subscriptionId);
      } catch (error) {
        const status = deliveryStatus(error);
        if (status === 404 || status === 410) {
          expired += 1;
          await this.repository.removeExpiredSubscription(delivery.subscriptionId);
          continue;
        }
        const message = deliveryError(error);
        retryErrors.push(message);
        await this.repository.markDeliveryRetry(delivery.outboxId, delivery.subscriptionId, message);
      }
    }

    if (retryErrors.length > 0) {
      const message = retryErrors.slice(0, 3).join("; ");
      await this.repository.finishOutbox(outboxId, message, terminalAttempt);
      throw new Error(message);
    }

    await this.repository.finishOutbox(outboxId);
    if (attempted === 0) return "empty";
    return expired === attempted ? "expired" : "sent";
  }
}

export function defaultPushPreferencesFor(eventType: WebPushEventType): boolean {
  return eventType !== "other";
}
