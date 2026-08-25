import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { requireWorkspace } from "../../auth/session.js";
import { isFeatureFlagEnabled } from "../operations/feature-flags.js";
import { WebPushRepository } from "./repository.js";

const subscriptionBody = z.object({
  endpoint: z.string().url().max(4_096).refine((value) => new URL(value).protocol === "https:", "Endpoint deve usar HTTPS"),
  expirationTime: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(16).max(512).regex(/^[A-Za-z0-9_-]+={0,2}$/),
    auth: z.string().min(8).max(512).regex(/^[A-Za-z0-9_-]+={0,2}$/)
  }).strict(),
  deviceName: z.string().trim().min(1).max(120).default("Dispositivo")
}).strict();

const deleteSubscriptionBody = z.object({ endpoint: z.string().url().max(4_096) }).strict();
const preferencesBody = z.object({
  web_push_enabled: z.boolean().optional(),
  push_assigned_messages: z.boolean().optional(),
  push_assignments: z.boolean().optional(),
  push_appointments: z.boolean().optional(),
  push_critical_alerts: z.boolean().optional(),
  push_other: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "Informe ao menos uma preferência");

function vapidConfigured() {
  return Boolean(config.WEB_PUSH_PUBLIC_KEY && config.WEB_PUSH_PRIVATE_KEY && config.WEB_PUSH_SUBJECT);
}

async function available(tenantId: string) {
  return vapidConfigured() && await isFeatureFlagEnabled(db, tenantId, "web_push_v1");
}

export async function registerWebPushRoutes(app: FastifyInstance) {
  const repository = new WebPushRepository(db);

  app.get("/me/push", async (request) => {
    const session = await requireWorkspace(request);
    const [preferences, subscriptionCount, enabled] = await Promise.all([
      repository.preferences(session.tenantId, session.userId),
      repository.subscriptionCount(session.tenantId, session.userId),
      available(session.tenantId)
    ]);
    return {
      enabled,
      configured: vapidConfigured(),
      public_key: enabled ? config.WEB_PUSH_PUBLIC_KEY : null,
      subscription_count: subscriptionCount,
      preferences
    };
  });

  app.patch("/me/push/preferences", async (request) => {
    const session = await requireWorkspace(request);
    const preferences = await repository.updatePreferences(
      session.tenantId,
      session.userId,
      preferencesBody.parse(request.body)
    );
    return { preferences };
  });

  app.post("/me/push/subscriptions", async (request, reply) => {
    const session = await requireWorkspace(request);
    if (!await available(session.tenantId)) {
      return reply.status(503).send({ error: "Web Push indisponível neste workspace" });
    }
    const body = subscriptionBody.parse(request.body);
    const subscription = await repository.upsertSubscription({
      tenantId: session.tenantId,
      userId: session.userId,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      expirationTime: body.expirationTime,
      deviceName: body.deviceName,
      userAgent: typeof request.headers["user-agent"] === "string"
        ? request.headers["user-agent"].slice(0, 500)
        : undefined
    });
    await repository.updatePreferences(session.tenantId, session.userId, { web_push_enabled: true });
    return reply.status(201).send({ subscription: { id: subscription.id } });
  });

  app.delete("/me/push/subscriptions", async (request, reply) => {
    const session = await requireWorkspace(request);
    const { endpoint } = deleteSubscriptionBody.parse(request.body);
    await repository.deleteSubscription(session.tenantId, session.userId, endpoint);
    return reply.status(204).send();
  });
}
