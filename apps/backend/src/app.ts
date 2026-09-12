import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { compare, hash } from "bcryptjs";
import { errors, jwtVerify } from "jose";
import Fastify from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { createSessionToken, requireIdentity, requirePermission, requireRootWorkspace, requireSession, requireWorkspace } from "./auth/session.js";
import { buildMePayload, listWorkspacesForUser } from "./auth/workspace-service.js";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { logger } from "./logger.js";
import { MessageRepository } from "./modules/messages/repository.js";
import { parseIdempotencyKey, payloadFingerprint } from "./modules/messages/idempotency.js";
import { AiFollowUpProcessor } from "./modules/messages/ai-follow-up.js";
import { enqueueFollowUpOnce } from "./modules/messages/follow-up-idempotency.js";
import { OpenRouterClient } from "./modules/ai-router/openrouter.js";
import { defaultStageId } from "./modules/commercial-journey/service.js";
import { applySignature, resolveSignatureSettings, type SignatureFormat, type SignatureNameStyle } from "./modules/messages/signature.js";
import { enqueueInboundRecovery } from "./queue/message-queue.js";
import { handleEvolutionWebhook } from "./modules/whatsapp/webhook-handler.js";
import { registerSchedulingRoutes } from "./modules/scheduling/routes.js";
import { registerMeetRoutes } from "./modules/meet/routes.js";
import { registerWorkspaceRoutes } from "./modules/workspaces/routes.js";
import { registerRootRoutes } from "./modules/root/routes.js";
import { registerSaasRoutes } from "./modules/saas/routes.js";
import { registerBillingRoutes } from "./modules/billing/routes.js";
import { getVersionInfo } from "./modules/root/version.js";
import { registerQualificationRoutes } from "./modules/qualification/routes.js";
import { QualificationService } from "./modules/qualification/service.js";
import { DEFAULT_MEDIA_FALLBACK } from "./modules/ai-router/defaults.js";
import { AVAILABLE_TOOL_NAMES } from "./modules/ai-router/tools.js";
import { WhatsAppSessionManager } from "./modules/whatsapp/session-manager.js";
import { registerWhatsAppConnectionRoutes } from "./modules/whatsapp/routes.js";
import { migrateHumanizerConfig } from "./modules/messages/humanizer.js";
import { checkReadiness } from "./readiness.js";
import { AiFollowUpRepository } from "./modules/messages/ai-follow-up.js";
import { decodeFollowUpMedia, FollowUpMediaRepository } from "./modules/messages/follow-up-media.js";
import { decodeOutboundMedia, safeMediaResponseMime } from "./modules/messages/outbound-media.js";
import { registerStickerRoutes } from "./modules/stickers/routes.js";
import { loadCommercialDashboard } from "./modules/dashboard/service.js";
import { registerDashboardWidgetRoutes } from "./modules/dashboard-widgets/routes.js";
import { registerOrganizationRoutes } from "./modules/organization/routes.js";
import { registerOperationsRoutes } from "./modules/operations/routes.js";
import { isCapabilityEnabled, isFeatureFlagEnabled, type FeatureFlagKey } from "./modules/operations/feature-flags.js";
import { RealtimeCoordinator } from "./modules/realtime/coordinator.js";
import { registerRealtimeRoutes } from "./modules/realtime/routes.js";
import { aiTurnProgressStore } from "./modules/realtime/ai-turn-progress.js";
import { registerWebPushRoutes } from "./modules/web-push/routes.js";
import { registerPostSalesRoutes } from "./modules/post-sales/routes.js";
import {
  registerTripzAiRoutes,
  type TripzDocumentRenderContext,
  type TripzMessageCreatedContext
} from "./modules/tripz-ai/routes.js";
import { TripzAiRepository } from "./modules/tripz-ai/repository.js";
import { TripzAiError } from "./modules/tripz-ai/domain.js";
import { TripzDocumentService } from "./modules/tripz-ai/document/service.js";
import { enqueueTripzAiTurn } from "./queue/tripz-ai-queue.js";
import { panelPresence } from "./modules/realtime/presence.js";
import { withTenantTransaction } from "./db/tenant-transaction.js";
import { fetchOpenRouterCreditBalance } from "./modules/usage/openrouter-credits.js";
import {
  canAccessConversation,
  conversationScopeCondition,
  hasWorkspaceCaseAccess,
  resolveCaseScope
} from "./auth/case-scope.js";
import { transferCaseAssignment } from "./modules/assignments/service.js";
import { refreshAppointmentGroupNotificationsForConversation } from "./modules/scheduling/notification-repository.js";
import {
  createRedisRateLimitStore,
  HTTP_RATE_LIMITS,
  httpRateLimitKey
} from "./security/http-rate-limit.js";
import { enforceRequestCapability } from "./capabilities/gate.js";
import { enforceRequestEntitlement } from "./billing/entitlement-gate.js";
import { processBillingWebhook } from "./billing/webhook-service.js";
import { assertHomologatedProvider } from "./billing/providers/homologation.js";
import { registerConversationQueueRoutes } from "./modules/conversations/queues.js";

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200)
});
const requiredPasswordChangeSchema = z.object({
  newPassword: z.string().min(12).max(200),
  passwordConfirmation: z.string().min(12).max(200)
}).refine((value) => value.newPassword === value.passwordConfirmation, {
  message: "A confirmação da nova senha não confere",
  path: ["passwordConfirmation"]
});
const switchWorkspaceSchema = z.object({ workspaceId: z.string().uuid() });
const profileUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(254).optional(),
  currentPassword: z.string().min(1).max(200).optional(),
  newPassword: z.string().min(12).max(200).optional()
}).refine((value) => value.name || value.email || value.newPassword, "Informe nome, e-mail ou nova senha")
  .refine((value) => !(value.email || value.newPassword) || value.currentPassword, "Informe a senha atual para alterar e-mail ou senha");
const notificationPreferencesSchema = z.object({
  enabled: z.boolean().optional(),
  sound_enabled: z.boolean().optional(),
  visual_enabled: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "Informe ao menos uma preferência");
const notificationMuteSchema = z.object({ muted: z.boolean() }).strict();
const contactUpdateSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict();
const workspaceUpdateSchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  attendantPhone: z.preprocess(
    (value) => value === "" ? null : value,
    z.string().trim().regex(/^\d{10,15}$/, "Use somente DDI, DDD e número").nullable().optional()
  )
}).refine((value) => value.name || value.attendantPhone !== undefined, "Informe um campo para atualizar");
export const agentSchema = z.object({
  systemPrompt: z.string().min(1).refine((value) => value.trim().length > 0, "Informe as instruções do agente"),
  aiModel: z.string().trim().min(1).max(200),
  openRouterProvider: z.string().trim().max(100).regex(/^[a-z0-9][a-z0-9._/-]*$/i, "Use o slug do provider exibido pela OpenRouter").optional()
    .transform((value) => value?.trim() ? value.trim().toLocaleLowerCase("en-US") : ""),
  temperature: z.number().min(0).max(2), maxTokens: z.number().int().min(64).max(8192), isActive: z.boolean(),
  reasoningEffort: z.enum(["low", "medium", "high"]).default("medium"),
  openRouterApiKey: z.string().trim().max(500).optional(),
  clearOpenRouterApiKey: z.boolean().default(false),
  mediaFallbackAudio: z.string().trim().min(1).max(2_000).default(DEFAULT_MEDIA_FALLBACK.audio),
  mediaFallbackImage: z.string().trim().min(1).max(2_000).default(DEFAULT_MEDIA_FALLBACK.image),
  mediaFallbackDocument: z.string().trim().min(1).max(2_000).default(DEFAULT_MEDIA_FALLBACK.document),
  // Conexão-alvo do prompt. Ausente/null = configuração compartilhada por todos
  // os números (padrão); preenchida = prompt exclusivo daquele número.
  sessionId: z.string().uuid().nullable().optional(),
  enabledTools: z.array(z.string()).min(1).max(AVAILABLE_TOOL_NAMES.length)
    .refine((names) => names.every((name) => AVAILABLE_TOOL_NAMES.includes(name)), "Há uma ferramenta desconhecida")
    .transform((names) => [...new Set(names)])
    .optional()
});
const agentStatusSchema = z.object({ isActive: z.boolean(), sessionId: z.string().uuid().nullable().optional() });
const messageSchema = z.union([
  z.object({ text: z.string().trim().min(1).max(4_000), replyToMessageId: z.string().uuid().optional() }),
  z.object({
    mediaType: z.enum(["audio", "image", "document"]),
    mimeType: z.string().trim().min(1).max(200),
    fileName: z.string().trim().min(1).max(240),
    dataBase64: z.string().min(1).max(45_000_000),
    caption: z.string().trim().max(4_000).optional(),
    replyToMessageId: z.string().uuid().optional()
  })
]);
const messageReactionSchema = z.object({ emoji: z.string().trim().min(1).max(8).nullable() });
const messageEditSchema = z.object({ text: z.string().trim().min(1).max(4_000) });
const WHATSAPP_CHANNEL_ERROR = "Esta conversa pertence ao canal Instagram e não pode ser enviada pelo WhatsApp";

function whatsappChannelError(channel: "whatsapp" | "instagram" | null | undefined) {
  return channel === "instagram" ? WHATSAPP_CHANNEL_ERROR : null;
}
const messageDeleteSchema = z.object({ forEveryone: z.boolean().default(false) });
const conversationsQuerySchema = z.object({
  filter: z.enum(["all", "human", "ai", "mine", "unassigned", "scheduled", "resolved"]).catch("all"),
  q: z.string().trim().max(120).optional().transform((value) => value || undefined),
  queue_id: z.string().uuid().optional(),
  session_id: z.string().uuid().optional(),
  unread: z.enum(["true", "false"]).optional(),
  pending_action: z.enum(["true", "false"]).optional()
});
const messageCursorPayloadSchema = z.object({
  v: z.literal(1),
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().uuid()
}).strict();
const messageCursorSchema = z.string().trim().min(1).max(512).transform((value, context) => {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || Buffer.from(value, "base64url").toString("base64url") !== value) {
      throw new Error("non-canonical cursor");
    }
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const parsed = messageCursorPayloadSchema.safeParse(decoded);
    if (!parsed.success) throw new Error("invalid cursor payload");
    return parsed.data;
  } catch {
    context.addIssue({ code: "custom", message: "Cursor de mensagens inválido" });
    return z.NEVER;
  }
});
const conversationAssetsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: messageCursorSchema.optional()
}).strict();
const conversationMessagesV2QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: messageCursorSchema.optional(),
  after: messageCursorSchema.optional()
}).refine((value) => !(value.before && value.after), {
  message: "Use somente before ou after"
});
const conversationAssignmentSchema = z.object({ userId: z.string().uuid().nullable() });
const idParams = z.object({ id: z.string().uuid() });
const messageIdParams = z.object({ id: z.string().uuid(), messageId: z.string().uuid() });
const alertsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).catch(50),
  offset: z.coerce.number().int().min(0).catch(0)
});
const alertNotificationClaimSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20)
});

function featureFlagDisabled(key: FeatureFlagKey, fallback: string) {
  return {
    error: "Recurso temporariamente disponível no modo compatível",
    code: "FEATURE_FLAG_DISABLED",
    feature: key,
    fallback
  };
}
const dashboardQuerySchema = z.object({
  period: z.enum(["today", "week", "month", "custom"]).catch("today"),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional();
const rangeSchema = z.object({ min: z.number().int().min(0), max: z.number().int().min(0) }).refine((value) => value.max >= value.min, "Máximo deve ser maior ou igual ao mínimo");

function encodeMessageCursor(row: { created_at: Date | string; id: string }): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    createdAt: typeof row.created_at === "string" ? row.created_at : new Date(row.created_at).toISOString(),
    id: row.id
  })).toString("base64url");
}
const humanizerSchema = z.object({
  readDelay: rangeSchema, readingPause: rangeSchema,
  composing: z.object({ wpm: z.number().positive().max(1000), jitterMs: z.number().int().min(0).max(60_000), minMs: z.number().int().min(0).max(300_000), maxMs: z.number().int().min(0).max(300_000), resendIntervalMs: z.number().int().min(500).max(60_000) }).refine((value) => value.maxMs >= value.minMs, "maxMs deve ser maior ou igual a minMs"),
  presence: z.object({ onlineSessionMin: rangeSchema, offlineGapMin: rangeSchema, inactivityBeforeUnavailableMin: z.number().min(0).max(1440), activeHours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) }) }),
  debounce: z.object({ initialWindowMs: rangeSchema, silenceWindowMs: rangeSchema, extensionMs: rangeSchema }),
  messageSplit: z.object({ maxWordsPerBubble: z.number().int().min(1).max(1000), pauseBetweenBubblesMs: rangeSchema }),
  timeOfDayMultiplier: z.object({ outsideActiveHours: z.number().min(1).max(10) }),
  reaction: z.object({ probability: z.number().min(0).max(1), emojis: z.array(z.string().trim().min(1).max(16)).max(20) }),
  rateLimit: z.object({ maxMessagesPerContactPerMinute: z.number().int().min(1).max(1000) })
});
const signatureSettingsSchema = z.object({
  enabled: z.boolean(),
  format: z.enum(["name_colon", "bold_name_colon", "role_name_colon", "separate_line"]),
  nameStyle: z.enum(["full", "first_name"])
});
const conversationSignatureSchema = z.object({ enabled: z.boolean().nullable() });
export const aiFollowUpSettingsSchema = z.object({
  enabled: z.boolean(),
  delaysMinutes: z.array(z.number().int().min(1).max(43_200)).min(1).max(10).optional(),
  delivery: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text") }),
    z.object({ type: z.literal("image"), assetId: z.string().uuid() }),
    z.object({ type: z.literal("audio"), assetId: z.string().uuid() }),
    z.object({ type: z.literal("video"), assetId: z.string().uuid() }),
    z.object({ type: z.literal("sticker"), assetId: z.string().uuid() })
  ])).min(1).max(10).optional(),
  // Compatibilidade temporária com clientes anteriores. A API persiste e
  // executa somente a sequência cumulativa em delaysMinutes.
  maxCount: z.number().int().min(1).max(10).optional(),
  intervalMinutes: z.number().int().min(1).max(43_200).optional()
}).superRefine((value, context) => {
  if (!value.delaysMinutes && (value.maxCount === undefined || value.intervalMinutes === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Informe delaysMinutes ou maxCount e intervalMinutes" });
  }
  const delays = value.delaysMinutes
    ?? (value.maxCount && value.intervalMinutes
      ? Array.from({ length: value.maxCount }, (_, index) => value.intervalMinutes! * (index + 1))
      : []);
  if (delays.some((delay, index) => delay > 43_200 || (index > 0 && delay <= delays[index - 1]!))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["delaysMinutes"],
      message: "Os atrasos devem ser cumulativos, crescentes e de no máximo 43200 minutos"
    });
  }
  if (value.delivery && value.delivery.length !== delays.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["delivery"],
      message: "Configure um tipo de envio para cada tentativa"
    });
  }
}).transform((value) => ({
  enabled: value.enabled,
  delaysMinutes: value.delaysMinutes
    ?? Array.from({ length: value.maxCount! }, (_, index) => value.intervalMinutes! * (index + 1)),
  delivery: value.delivery
    ?? Array.from(
      { length: value.delaysMinutes?.length ?? value.maxCount! },
      () => ({ type: "text" as const })
    )
}));
const followUpMediaBodySchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().min(3).max(500),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "audio/ogg", "audio/mpeg", "video/mp4"]),
  fileName: z.string().trim().min(1).max(180),
  dataBase64: z.string().min(1).max(24_000_000)
});
// A fixed, non-secret bcrypt hash keeps the unknown-account login path from
// becoming a cheap timing oracle. It intentionally uses the production cost.
const INVALID_LOGIN_PASSWORD_HASH = "$2b$12$d8WKhObib6O/K5ui9JgPVOfUTy3mVEpbVfLTn.lLc60WKNtYZX5g2";

function csvCell(value: unknown): string {
  const raw = String(value ?? "");
  // Spreadsheet programs execute cells beginning with these characters as
  // formulas. Prefixing an apostrophe keeps exported tenant-controlled values
  // (notably model names) as text.
  const text = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

type AuditLogInput = {
  actorUserId: string;
  workspaceId?: string | null;
  actorScope: "root" | "workspace";
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
};

async function insertAuditLog(connection: Pick<Pool | PoolClient, "query">, input: AuditLogInput) {
  await connection.query(
    `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.actorUserId,
      input.workspaceId ?? null,
      input.actorScope,
      input.action,
      input.resourceType,
      input.resourceId ?? null,
      input.metadata ?? {},
      input.ipAddress ?? null,
      input.userAgent ?? null
    ]
  );
}

async function auditLog(input: AuditLogInput) {
  await insertAuditLog(db, input);
}

export function buildApp(options: { billingOAuth?: import("./modules/billing/routes.js").BillingOAuthDependencies } = {}) {
  // Production traffic reaches Fastify through the loopback Nginx proxy. Trust
  // forwarded addresses only from that boundary so rate limits and audit logs
  // identify the real client without accepting spoofed headers from the network.
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: ["127.0.0.1", "::1"],
    connectionTimeout: 15_000,
    requestTimeout: 75_000,
    keepAliveTimeout: 72_000,
    onProtoPoisoning: "error",
    onConstructorPoisoning: "error"
  });
  const realtime = new RealtimeCoordinator(db, config.REDIS_URL, app.log);
  const whatsapp = new WhatsAppSessionManager(db, config, app.log);
  const tripzRepository = new TripzAiRepository(db);
  const tripzDocuments = new TripzDocumentService(tripzRepository);
  const distributedRateLimit = config.NODE_ENV === "production"
    ? createRedisRateLimitStore(config.REDIS_URL, (error) => {
        app.log.warn({ err: error }, "Distributed HTTP rate limiter unavailable");
      })
    : undefined;
  void app.register(cookie);
  void app.register(cors, {
    origin: config.PANEL_ORIGIN,
    credentials: true,
    allowedHeaders: ["content-type", "authorization", "idempotency-key", "last-event-id", "x-tripz-file-name", "x-file-name"]
  });
  void app.register(rateLimit, {
    global: false,
    hook: "preValidation",
    keyGenerator: httpRateLimitKey,
    skipOnError: true,
    onExceeded: (request) => {
      request.log.warn({
        method: request.method,
        route: request.routeOptions.url
      }, "HTTP rate limit exceeded");
    },
    ...(distributedRateLimit ? { store: distributedRateLimit.Store } : {})
  });

  app.addHook("onRequest", async (request, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method) || request.url.startsWith("/webhooks/evolution") || request.url.startsWith("/webhooks/billing")) return;
    const origin = request.headers.origin;
    const fetchSite = request.headers["sec-fetch-site"];
    if ((origin && origin !== config.PANEL_ORIGIN) || fetchSite === "cross-site") {
      return reply.status(403).send({ error: "Origem não permitida" });
    }
  });

  app.addHook("preHandler", enforceRequestCapability);
  app.addHook("preHandler", enforceRequestEntitlement);

  app.addHook("onSend", async (_request, reply, payload) => {
    if (!reply.hasHeader("cache-control")) {
      void reply.header("cache-control", "no-store");
    }
    void reply
      .header("x-content-type-options", "nosniff")
      .header("x-frame-options", "DENY")
      .header("referrer-policy", "no-referrer")
      .header("permissions-policy", "camera=(), microphone=(), geolocation=()")
      .header("content-security-policy", "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    const typed = error as Error & {
      statusCode?: number;
      code?: string;
      feature?: string;
      existingId?: string;
      details?: unknown;
    };
    const status = typeof typed.statusCode === "number" ? typed.statusCode : error instanceof z.ZodError ? 400 : 500;
    if (status >= 500) app.log.error(error);
    if (error instanceof TripzAiError) {
      return reply.status(status).send({
        error: typed.message,
        code: error.code,
        ...(error.code === "FEATURE_FLAG_DISABLED" ? { feature: "tripz_ai_v1" } : {})
      });
    }
    return reply.status(status).send({
      error: status === 500 ? "Erro interno" : typed.message,
      ...(status < 500 && typed.code ? { code: typed.code } : {}),
      ...(status < 500 && typed.feature ? { feature: typed.feature } : {}),
      ...(status < 500 && typed.existingId ? { existing_id: typed.existingId } : {}),
      ...(status < 500 && typed.details ? { details: typed.details } : {})
    });
  });

  app.get("/health", async (_request, reply) => {
    try { await db.query("SELECT 1"); return { status: "ok" }; }
    catch { return reply.status(503).send({ status: "degraded" }); }
  });

  app.get("/ready", async (_request, reply) => {
    const readiness = await checkReadiness();
    return reply.status(readiness.ready ? 200 : 503).send({
      status: readiness.ready ? "ready" : "not_ready",
      checks: readiness.checks
    });
  });

  app.get("/version", async () => getVersionInfo());
  app.get("/api/version", async () => getVersionInfo());
  app.get("/panel/version", async (request) => {
    const session = await requireWorkspace(request);
    const tenant = await db.query<{ slug: string }>("SELECT slug FROM tenants WHERE id=$1", [session.tenantId]);
    return getVersionInfo(tenant.rows[0]?.slug);
  });

  registerRealtimeRoutes(app, realtime);
  app.addHook("onClose", async () => {
    await whatsapp.stopAll();
    await realtime.stop();
    await panelPresence.close();
    await aiTurnProgressStore.close();
    await distributedRateLimit?.close();
  });

  /**
   * Webhook de cobrança (§18). Público e sem sessão, como o da Evolution.
   *
   * O corpo é recebido como STRING crua num escopo isolado (`register`), porque o
   * HMAC do gateway é calculado sobre os bytes originais — reparsear o JSON mudaria
   * a assinatura. O parser fica confinado a este plugin e não afeta as demais rotas.
   */
  void app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => done(null, body));
    scope.post<{ Params: { providerCode: string } }>("/webhooks/billing/:providerCode", {
      bodyLimit: 1024 * 1024,
      config: { rateLimit: HTTP_RATE_LIMITS.webhook }
    }, async (request, reply) => {
      const rawBody = typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {});
      try {
        assertHomologatedProvider(request.params.providerCode);
        const outcome = await processBillingWebhook(
          request.params.providerCode,
          rawBody,
          request.headers as Record<string, string | string[] | undefined>,
          config.DATA_ENCRYPTION_KEY
        );
        // Evento repetido responde 200 sem reprocessar: o provider para de reenviar.
        return reply.status(200).send({ ok: true, status: outcome.status });
      } catch (error) {
        const typed = error as Error & { statusCode?: number; code?: string };
        const status = typeof typed.statusCode === "number" ? typed.statusCode : 500;
        if (status >= 500) app.log.error({ err: error, provider: request.params.providerCode }, "Billing webhook processing failed");
        else app.log.warn({ provider: request.params.providerCode, code: typed.code }, "Billing webhook rejected");
        return reply.status(status).send({ error: status >= 500 ? "Erro interno" : typed.message, ...(typed.code ? { code: typed.code } : {}) });
      }
    });
  });

  app.post("/webhooks/evolution", {
    bodyLimit: 1024 * 1024,
    config: { rateLimit: HTTP_RATE_LIMITS.webhook }
  }, async (request, reply) => handleEvolutionWebhook(request, reply, { db, whatsapp, log: app.log }));

  app.after(() => {
    app.post("/auth/login", { config: { rateLimit: HTTP_RATE_LIMITS.login } }, async (request, reply) => {
      const body = loginSchema.parse(request.body);
      const email = body.email.toLocaleLowerCase("en-US");
      const userResult = await db.query<{
        id: string;
        email: string;
        password_hash: string | null;
        is_root: boolean;
        status: string;
        must_change_password: boolean;
      }>(
        "SELECT id,email,password_hash,is_root,status,must_change_password FROM users WHERE email=$1",
        [email]
      );
      const user = userResult.rows[0];
      const passwordMatches = await compare(body.password, user?.password_hash ?? INVALID_LOGIN_PASSWORD_HASH);
      if (!user || user.status !== "active" || !user.password_hash || !passwordMatches) {
        return reply.status(401).send({ error: "E-mail ou senha inválidos" });
      }
      await db.query("UPDATE users SET last_login_at=now() WHERE id=$1", [user.id]);
      const workspaces = await listWorkspacesForUser(db, user.id, user.is_root);
      let activeWorkspace = workspaces[0];
      if (user.is_root) {
        const home = await db.query<{ workspace_id: string }>(
          "SELECT workspace_id FROM workspace_members WHERE user_id=$1 AND status='active' ORDER BY created_at LIMIT 1",
          [user.id]
        );
        activeWorkspace = workspaces.find((workspace) => workspace.id === home.rows[0]?.workspace_id) ?? activeWorkspace;
      }
      if (!activeWorkspace) return reply.status(403).send({ error: "Usuário sem workspace ativo" });
      const token = await createSessionToken({
        userId: user.id,
        tenantId: activeWorkspace.id,
        email: user.email,
        role: activeWorkspace.role,
        isRoot: user.is_root,
        rootWorkspaceAccess: user.is_root
      });
      reply.setCookie("atendon_session", token, { httpOnly: true, sameSite: "lax", secure: config.NODE_ENV === "production", path: "/", maxAge: 43_200 });
      return {
        user: {
          id: user.id,
          email: user.email,
          isRoot: user.is_root,
          mustChangePassword: user.must_change_password
        },
        activeWorkspace,
        workspaces
      };
    });

    app.post("/auth/password-change-required", { config: { rateLimit: HTTP_RATE_LIMITS.authentication } }, async (request, reply) => {
      const identity = await requireIdentity(request, { allowPasswordChangeRequired: true });
      const body = requiredPasswordChangeSchema.parse(request.body);
      const current = await db.query<{ password_hash: string | null; must_change_password: boolean }>(
        "SELECT password_hash,must_change_password FROM users WHERE id=$1",
        [identity.userId]
      );
      const user = current.rows[0];
      if (!user?.must_change_password) {
        return reply.status(409).send({ error: "Esta conta não possui troca de senha pendente" });
      }
      if (user.password_hash && await compare(body.newPassword, user.password_hash)) {
        return reply.status(400).send({ error: "Crie uma senha diferente da senha temporária" });
      }

      const updated = await db.query<{ session_version: number }>(
        `UPDATE users
         SET password_hash=$2,must_change_password=false,session_version=session_version+1,updated_at=now()
         WHERE id=$1 AND must_change_password=true
         RETURNING session_version`,
        [identity.userId, await hash(body.newPassword, 12)]
      );
      if (!updated.rows[0]) {
        return reply.status(409).send({ error: "A troca de senha já foi concluída" });
      }

      const token = await createSessionToken({
        ...identity,
        sessionVersion: updated.rows[0].session_version,
        mustChangePassword: false
      });
      reply.setCookie("atendon_session", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: config.NODE_ENV === "production",
        path: "/",
        maxAge: 43_200
      });
      return { ok: true, user: { isRoot: identity.isRoot } };
    });
  });

  app.post("/auth/logout", { config: { rateLimit: HTTP_RATE_LIMITS.sensitiveWrite } }, async (request, reply) => {
    const token = request.cookies.atendon_session;
    if (token) {
      try {
        const { payload } = await jwtVerify(token, new TextEncoder().encode(config.JWT_SECRET), { algorithms: ["HS256"] });
        const userId = String(payload.userId);
        const current = await db.query<{ status: string; session_version: number }>("SELECT status,session_version FROM users WHERE id=$1", [userId]);
        const user = current.rows[0];
        if (user?.status === "active" && Number(payload.sessionVersion) === user.session_version) {
          await db.query("UPDATE users SET session_version=session_version+1,updated_at=now() WHERE id=$1 AND session_version=$2", [userId, user.session_version]);
        }
      } catch (error) {
        if (error instanceof errors.JOSEError) return reply.clearCookie("atendon_session", { path: "/" }).send({ ok: true });
        throw error;
      }
    }
    reply.clearCookie("atendon_session", { path: "/" });
    return { ok: true };
  });
  app.get("/me", async (request) => buildMePayload(await requireSession(request)));
  app.get("/me/notification-preferences", async (request) => {
    const session = await requireSession(request);
    const [preferences, muted] = await Promise.all([
      db.query<{ enabled: boolean; sound_enabled: boolean; visual_enabled: boolean }>(
        `SELECT enabled,sound_enabled,visual_enabled
         FROM panel_notification_preferences WHERE tenant_id=$1 AND user_id=$2`,
        [session.tenantId, session.userId]
      ),
      db.query<{ id: string; contact_name: string | null; contact_phone: string; muted_at: Date }>(
        `SELECT conversation.id,conversation.contact_name,conversation.contact_phone,mute.created_at muted_at
         FROM panel_notification_conversation_mutes mute
         JOIN conversations conversation
           ON conversation.id=mute.conversation_id AND conversation.tenant_id=mute.tenant_id
         WHERE mute.tenant_id=$1 AND mute.user_id=$2
         ORDER BY mute.created_at DESC`,
        [session.tenantId, session.userId]
      )
    ]);
    return {
      preferences: preferences.rows[0] ?? { enabled: true, sound_enabled: true, visual_enabled: true },
      muted_conversations: muted.rows
    };
  });
  app.patch("/me/notification-preferences", async (request) => {
    const session = await requireSession(request);
    const body = notificationPreferencesSchema.parse(request.body);
    const updated = await db.query<{ enabled: boolean; sound_enabled: boolean; visual_enabled: boolean }>(
      `INSERT INTO panel_notification_preferences(tenant_id,user_id,enabled,sound_enabled,visual_enabled)
       VALUES($1,$2,COALESCE($3,true),COALESCE($4,true),COALESCE($5,true))
       ON CONFLICT(tenant_id,user_id) DO UPDATE SET
         enabled=COALESCE($3,panel_notification_preferences.enabled),
         sound_enabled=COALESCE($4,panel_notification_preferences.sound_enabled),
         visual_enabled=COALESCE($5,panel_notification_preferences.visual_enabled),
         updated_at=now()
       RETURNING enabled,sound_enabled,visual_enabled`,
      [session.tenantId, session.userId, body.enabled ?? null, body.sound_enabled ?? null, body.visual_enabled ?? null]
    );
    return { preferences: updated.rows[0] };
  });
  app.patch("/me/profile", { config: { rateLimit: HTTP_RATE_LIMITS.sensitiveWrite } }, async (request, reply) => {
    const session = await requireSession(request);
    const body = profileUpdateSchema.parse(request.body);
    const current = await db.query<{ email: string; password_hash: string | null; is_root: boolean; session_version: number }>(
      "SELECT email,password_hash,is_root,session_version FROM users WHERE id=$1",
      [session.userId]
    );
    const user = current.rows[0];
    const changingCredentials = Boolean(body.email || body.newPassword);
    if (changingCredentials && (!user?.password_hash || !(await compare(body.currentPassword ?? "", user.password_hash)))) {
      return reply.status(401).send({ error: "Senha atual inválida" });
    }

    const nextEmail = body.email?.toLocaleLowerCase("en-US") ?? user.email;
    const nextPasswordHash = body.newPassword ? await hash(body.newPassword, 12) : user.password_hash;
    const updated = await db.query<{ email: string; session_version: number }>(
      `UPDATE users
       SET email=$2,name=COALESCE($4,name),password_hash=$3,
           must_change_password=CASE WHEN $6::boolean THEN false ELSE must_change_password END,
           session_version=session_version+($5::int),updated_at=now()
       WHERE id=$1
       RETURNING email,session_version`,
      [session.userId, nextEmail, nextPasswordHash, body.name ?? null, changingCredentials ? 1 : 0, Boolean(body.newPassword)]
    ).catch((error: unknown) => {
      if (typeof error === "object" && error && "code" in error && error.code === "23505") {
        throw Object.assign(new Error("Este e-mail já está em uso"), { statusCode: 409 });
      }
      throw error;
    });
    const token = await createSessionToken({
      userId: session.userId,
      tenantId: session.tenantId,
      email: updated.rows[0].email,
      role: session.role,
      isRoot: session.isRoot,
      sessionVersion: updated.rows[0].session_version,
      rootWorkspaceAccess: session.isRoot ? true : session.rootWorkspaceAccess
    });
    reply.setCookie("atendon_session", token, { httpOnly: true, sameSite: "lax", secure: config.NODE_ENV === "production", path: "/", maxAge: 43_200 });
    return buildMePayload({ ...session, email: updated.rows[0].email });
  });

  app.get("/workspaces/current", async (request) => buildMePayload(await requirePermission(request, "workspace.read")));
  app.patch("/workspaces/current", async (request) => {
    const session = await requirePermission(request, "workspace.update");
    const body = workspaceUpdateSchema.parse(request.body);
    const result = await db.query(
      `UPDATE tenants SET
         name=COALESCE($2,name),
         attendant_phone=CASE WHEN $3::boolean THEN $4 ELSE attendant_phone END,
         updated_at=now()
       WHERE id=$1
       RETURNING id,name,slug,status,attendant_phone,updated_at`,
      [session.tenantId, body.name ?? null, body.attendantPhone !== undefined, body.attendantPhone ?? null]
    );
    await auditLog({
      actorUserId: session.userId,
      workspaceId: session.tenantId,
      actorScope: session.actorScope,
      action: "workspace.update",
      resourceType: "workspace",
      resourceId: session.tenantId,
      metadata: body,
      ipAddress: request.ip,
      userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined
    });
    return { workspace: result.rows[0] };
  });
  app.post("/workspaces/switch", async (request, reply) => {
    const current = await requireSession(request);
    const { workspaceId } = switchWorkspaceSchema.parse(request.body);
    const workspaces = await listWorkspacesForUser(db, current.userId, current.isRoot);
    const selected = workspaces.find((workspace) => workspace.id === workspaceId);
    if (!selected) return reply.status(403).send({ error: "Workspace não autorizado" });
    const token = await createSessionToken({
      userId: current.userId,
      tenantId: selected.id,
      email: current.email,
      role: selected.role,
      isRoot: current.isRoot,
      rootWorkspaceAccess: current.isRoot
    });
    reply.setCookie("atendon_session", token, { httpOnly: true, sameSite: "lax", secure: config.NODE_ENV === "production", path: "/", maxAge: 43_200 });
    if (current.isRoot) {
      await auditLog({
        actorUserId: current.userId,
        workspaceId: selected.id,
        actorScope: "root",
        action: "root.workspace.access",
        resourceType: "workspace",
        resourceId: selected.id,
        ipAddress: request.ip,
        userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined
      });
    }
    const permissions = current.isRoot
      ? []
      : (await db.query<{ permission_key: string }>(
          `SELECT rp.permission_key
           FROM workspace_members m
           JOIN workspace_role_permissions rp ON rp.role_id=m.role_id
           WHERE m.user_id=$1 AND m.workspace_id=$2 AND m.status='active'
           ORDER BY rp.permission_key`,
          [current.userId, selected.id]
        )).rows.map((row) => row.permission_key);
    return buildMePayload({
      userId: current.userId,
      email: current.email,
      isRoot: current.isRoot,
      tenantId: selected.id,
      role: selected.role,
      permissions,
      actorScope: current.isRoot ? "root" : "workspace",
      rootWorkspaceAccess: current.isRoot
    });
  });

  app.get("/alerts", async (request) => {
    const session = await requirePermission(request, "dashboard.read");
    if (!hasWorkspaceCaseAccess(session)) {
      throw Object.assign(new Error("Somente gestores podem acessar alertas"), { statusCode: 403 });
    }
    const { limit, offset } = alertsQuerySchema.parse(request.query);
    const appointmentsEnabled = await isCapabilityEnabled(db, session.tenantId, "appointments_v1");
    const rootMembership = session.isRoot
      ? await db.query(
          `SELECT 1
           FROM workspace_members m
           JOIN users u ON u.id=m.user_id AND u.status='active'
           WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.status='active'`,
          [session.tenantId, session.userId]
        )
      : null;
    // ROOT may inspect a workspace without becoming a member. In that mode
    // workspace alerts are read-only and never acquire implicit receipts/toasts.
    const rootReadOnly = session.isRoot === true && !rootMembership?.rows[0];
    const workspaceAudienceAccess = hasWorkspaceCaseAccess(session);
    const visibleAlertsSql = `
      FROM system_alerts a
      LEFT JOIN system_alert_receipts r
        ON r.alert_id=a.id AND r.tenant_id=a.tenant_id AND r.user_id=$2
      WHERE a.tenant_id=$1
        AND (r.user_id IS NOT NULL OR ($3::boolean AND a.audience='workspace'))
        AND ($4::boolean OR a.kind <> 'meeting')`;
    const [result, summary] = await Promise.all([
      db.query<{
        id: string;
        message: string;
        kind: "operational" | "meeting";
        metadata: Record<string, unknown>;
        created_at: string;
        notified_at: string | null;
        read_at: string | null;
        can_acknowledge: boolean;
      }>(
        `SELECT a.id,a.message,a.kind,a.metadata,a.created_at,r.notified_at,r.read_at,
                (r.user_id IS NOT NULL) can_acknowledge
         ${visibleAlertsSql}
         ORDER BY a.created_at DESC,a.id DESC
         LIMIT $5 OFFSET $6`,
        [session.tenantId, session.userId, workspaceAudienceAccess, appointmentsEnabled, limit, offset]
      ),
      db.query<{ total: number; unread: number }>(
        `SELECT count(*)::int total,
                count(*) FILTER(
                  WHERE r.user_id IS NOT NULL AND r.read_at IS NULL
                )::int unread
         ${visibleAlertsSql}`,
        [session.tenantId, session.userId, workspaceAudienceAccess, appointmentsEnabled]
      )
    ]);
    return {
      alerts: result.rows.map((row) => ({ ...row, should_toast: false })),
      unread: summary.rows[0]?.unread ?? 0,
      total: summary.rows[0]?.total ?? 0,
      offset,
      limit,
      receipt_mode: rootReadOnly ? "root_read_only" : "member"
    };
  });

  app.post("/alerts/notifications/claim", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    if (!await isFeatureFlagEnabled(db, session.tenantId, "alerts_delivery_v2")) {
      return reply.status(409).send(featureFlagDisabled("alerts_delivery_v2", "/alerts"));
    }
    const appointmentsEnabled = await isCapabilityEnabled(db, session.tenantId, "appointments_v1");
    const { limit } = alertNotificationClaimSchema.parse(request.body ?? {});
    const claimed = await db.query<{
      id: string;
      message: string;
      kind: "operational" | "meeting";
      metadata: Record<string, unknown>;
      created_at: string;
      notified_at: string;
    }>(
      `WITH candidates AS (
         SELECT r.alert_id,r.tenant_id,r.user_id
         FROM system_alert_receipts r
         JOIN system_alerts a ON a.id=r.alert_id AND a.tenant_id=r.tenant_id
         WHERE r.tenant_id=$1 AND r.user_id=$2
           AND r.notified_at IS NULL AND r.read_at IS NULL
           AND ($4::boolean OR a.kind <> 'meeting')
         ORDER BY a.created_at ASC,a.id ASC
         LIMIT $3
         FOR UPDATE OF r SKIP LOCKED
       ), updated AS (
         UPDATE system_alert_receipts r
         SET notified_at=now()
         FROM candidates c
         WHERE r.alert_id=c.alert_id
           AND r.tenant_id=c.tenant_id
           AND r.user_id=c.user_id
           AND r.notified_at IS NULL
           AND r.read_at IS NULL
         RETURNING r.alert_id,r.tenant_id,r.notified_at
       )
       SELECT a.id,a.message,a.kind,a.metadata,a.created_at,u.notified_at
       FROM updated u
       JOIN system_alerts a ON a.id=u.alert_id AND a.tenant_id=u.tenant_id
       ORDER BY a.created_at ASC,a.id ASC`,
      [session.tenantId, session.userId, limit, appointmentsEnabled]
    );
    return {
      alerts: claimed.rows.map((alert) => ({ ...alert, should_toast: true }))
    };
  });

  app.patch("/alerts/read-all", async (request) => {
    const session = await requireRootWorkspace(request);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const changed = await client.query<{ alert_id: string }>(
        `UPDATE system_alert_receipts
         SET notified_at=COALESCE(notified_at,now()),read_at=now()
         WHERE tenant_id=$1 AND user_id=$2 AND read_at IS NULL
         RETURNING alert_id`,
        [session.tenantId, session.userId]
      );
      if (changed.rowCount) {
        await client.query(
          `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
           VALUES($1,$2,$3,'system_alert.read_all','system_alert_receipts',NULL,$4,$5,$6)`,
          [
            session.userId,
            session.tenantId,
            session.actorScope,
            { count: changed.rowCount },
            request.ip,
            request.headers["user-agent"] ?? null
          ]
        );
      }
      await client.query("COMMIT");
      return { ok: true, updated: changed.rowCount ?? 0 };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.patch("/alerts/:id/read", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const { id } = idParams.parse(request.params);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const alert = await client.query<{ id: string; read_at: string | null }>(
        `SELECT a.id,r.read_at
         FROM system_alerts a
         JOIN system_alert_receipts r
           ON r.alert_id=a.id AND r.tenant_id=a.tenant_id
         WHERE a.id=$1 AND a.tenant_id=$2 AND r.user_id=$3`,
        [id, session.tenantId, session.userId]
      );
      if (!alert.rows[0]) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ error: "Alerta não encontrado" });
      }
      const changed = await client.query<{ read_at: string }>(
        `UPDATE system_alert_receipts SET notified_at=COALESCE(notified_at,now()),read_at=now()
         WHERE alert_id=$1 AND tenant_id=$2 AND user_id=$3 AND read_at IS NULL
         RETURNING read_at`,
        [id, session.tenantId, session.userId]
      );
      const readAt = changed.rows[0]?.read_at ?? (await client.query<{ read_at: string }>(
        `SELECT read_at FROM system_alert_receipts
         WHERE alert_id=$1 AND tenant_id=$2 AND user_id=$3`,
        [id, session.tenantId, session.userId]
      )).rows[0].read_at;
      if (changed.rows[0]) {
        await client.query(
          `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
           VALUES($1,$2,$3,'system_alert.read','system_alert',$4,'{}'::jsonb,$5,$6)`,
          [session.userId, session.tenantId, session.actorScope, id, request.ip, request.headers["user-agent"] ?? null]
        );
      }
      await client.query("COMMIT");
      return { ok: true, readAt };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/dashboard", async (request) => {
    const session = await requirePermission(request, "dashboard.read");
    const dashboardQuery = dashboardQuerySchema.parse(request.query);
    const caseScope = await resolveCaseScope(db, session);
    const scopeParams = [session.tenantId, caseScope.type === "workspace", session.userId];
    const [tenant, wa, counts, agent, handoffs, commercial, appointmentsEnabled] = await Promise.all([
      db.query("SELECT name FROM tenants WHERE id = $1", [session.tenantId]),
      db.query(`SELECT status, last_connected_at,
          count(*) OVER ()::int total,
          count(*) FILTER (WHERE status='connected') OVER ()::int connected
        FROM whatsapp_sessions
        WHERE tenant_id = $1 AND channel='whatsapp' AND archived_at IS NULL
        ORDER BY is_primary DESC, created_at DESC LIMIT 1`, [session.tenantId]),
      db.query(`SELECT count(*) FILTER (WHERE c.status='open')::int open,
        count(*) FILTER (WHERE c.status='open' AND c.ai_active=false AND c.handoff_reason IS DISTINCT FROM 'manually_paused')::int handoff,
        count(*) FILTER (WHERE c.status='open' AND c.ai_active=false AND c.assigned_user_id IS NULL AND c.handoff_reason IS DISTINCT FROM 'manually_paused')::int handoff_unassigned,
        count(*) FILTER (WHERE c.status='open' AND c.ai_active=false AND c.last_message_at < now() - interval '15 minutes' AND c.handoff_reason IS DISTINCT FROM 'manually_paused')::int handoff_over_sla,
        COALESCE(floor(extract(epoch FROM (now() - min(c.last_message_at) FILTER (WHERE c.status='open' AND c.ai_active=false AND c.handoff_reason IS DISTINCT FROM 'manually_paused'))) / 60),0)::int oldest_handoff_minutes,
        count(*) FILTER (WHERE c.status='closed' AND c.resolved_at >= date_trunc('day',now()))::int resolved_today,
        count(*) FILTER (WHERE c.status='open' AND c.ai_active=true)::int ai_open
        FROM conversations c
        WHERE c.tenant_id=$1 AND ($2::boolean OR c.assigned_user_id=$3)`, scopeParams),
      db.query("SELECT ai_model, is_active, updated_at FROM agent_configs WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 1", [session.tenantId]),
      db.query(`SELECT c.id, c.contact_name, c.contact_phone, c.contact_avatar_url avatar_url,
          c.handoff_reason, c.last_message_at,
          c.assigned_user_id, u.email assigned_user_email,
          floor(extract(epoch FROM (now() - c.last_message_at)) / 60)::int waiting_minutes
        FROM conversations c LEFT JOIN users u ON u.id=c.assigned_user_id
        WHERE c.tenant_id=$1 AND ($2::boolean OR c.assigned_user_id=$3)
          AND c.ai_active=false AND c.status='open' AND c.handoff_reason IS DISTINCT FROM 'manually_paused'
        ORDER BY last_message_at LIMIT 5`, scopeParams),
      loadCommercialDashboard(session, dashboardQuery),
      isCapabilityEnabled(db, session.tenantId, "appointments_v1")
    ]);
    const today = await db.query(`SELECT count(*)::int count FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE c.tenant_id=$1 AND ($2::boolean OR c.assigned_user_id=$3)
        AND m.created_at >= date_trunc('day', now())`, scopeParams);
    const canReadAgent = session.isRoot && session.rootWorkspaceAccess;
    return {
      tenant: tenant.rows[0],
      connection: wa.rows[0]
        ? { status: wa.rows[0].status, last_connected_at: wa.rows[0].last_connected_at }
        : { status: "disconnected" },
      connections_summary: {
        total: wa.rows[0]?.total ?? 0,
        connected: wa.rows[0]?.connected ?? 0,
        disconnected: (wa.rows[0]?.total ?? 0) - (wa.rows[0]?.connected ?? 0)
      },
      counts: { ...counts.rows[0], messagesToday: today.rows[0].count },
      agent: canReadAgent ? agent.rows[0] : null,
      handoffs: handoffs.rows,
      commercial: appointmentsEnabled ? commercial : {
        scope: commercial.scope,
        period: commercial.period,
        result: { new_contacts: commercial.result.new_contacts },
        operations: commercial.operations,
        sdr_metrics: {
          received: commercial.sdr_metrics.received,
          attended: commercial.sdr_metrics.attended,
          qualified: commercial.sdr_metrics.qualified,
          qualification_rate: commercial.sdr_metrics.qualification_rate,
          average_first_response_minutes: commercial.sdr_metrics.average_first_response_minutes,
          overdue_follow_ups: commercial.sdr_metrics.overdue_follow_ups
        }
      }
    };
  });

  app.get("/connection", async (request) => {
    const session = await requirePermission(request, "connection.read");
    const result = await db.query(`SELECT id, phone_number, status, qr_code, last_connected_at, disconnected_reason, created_at
      FROM whatsapp_sessions WHERE tenant_id=$1 AND channel='whatsapp' AND archived_at IS NULL
      ORDER BY is_primary DESC, created_at DESC LIMIT 1`, [session.tenantId]);
    return { connection: result.rows[0] ?? null };
  });

  app.post("/connection/reconnect", async (request, reply) => {
    const session = await requirePermission(request, "connection.manage");
    const result = await db.query<{ id: string }>(
      `SELECT id FROM whatsapp_sessions WHERE tenant_id=$1 AND channel='whatsapp' AND archived_at IS NULL
       ORDER BY is_primary DESC, created_at DESC LIMIT 1`,
      [session.tenantId]
    );
    if (!result.rows[0]) return reply.status(404).send({ error: "Sessão de WhatsApp não encontrada" });
    await whatsapp.reconnect(result.rows[0].id);
    return reply.status(202).send({ status: "qr_pending" });
  });

  app.get("/agent", async (request) => {
    const session = await requireRootWorkspace(request);
    const query = z.object({ session_id: z.string().uuid().nullable().optional() })
      .parse(request.query ?? {});
    const requestedSessionId = query.session_id ?? null;
    const result = await db.query(`SELECT a.id, a.active_version_id, a.session_id, a.system_prompt, a.ai_model, a.model_params, a.enabled_tools, a.is_active, a.updated_at,
        t.slug tenant_slug,
        s.openrouter_provider,
        (s.openrouter_api_key_encrypted IS NOT NULL) AS has_openrouter_api_key,
        COALESCE(s.media_fallback_audio,$3) media_fallback_audio,
        COALESCE(s.media_fallback_image,$4) media_fallback_image,
        COALESCE(s.media_fallback_document,$5) media_fallback_document
      FROM agent_configs a JOIN tenants t ON t.id=a.tenant_id
      LEFT JOIN tenant_ai_settings s ON s.tenant_id=a.tenant_id
      WHERE a.tenant_id=$1
        AND (a.session_id = $2::uuid OR a.session_id IS NULL)
      ORDER BY (a.session_id IS NOT NULL) DESC, a.updated_at DESC LIMIT 1`,
      [session.tenantId, requestedSessionId, DEFAULT_MEDIA_FALLBACK.audio, DEFAULT_MEDIA_FALLBACK.image, DEFAULT_MEDIA_FALLBACK.document]);
    const agent = result.rows[0] ?? null;
    return {
      agent,
      // "connection" = esta conexão tem prompt próprio; "shared" = está usando o
      // prompt comum a todos os números.
      scope: agent?.session_id ? "connection" : "shared",
      available_tools: AVAILABLE_TOOL_NAMES
    };
  });

  app.get("/usage", async (request) => {
    const session = await requireRootWorkspace(request);
    const requested = monthSchema.parse((request.query as { month?: string }).month);
    const month = requested ?? new Date().toISOString().slice(0, 7);
    const start = `${month}-01T00:00:00.000Z`;
    const [summary, daily, models, dailyModels] = await Promise.all([
      db.query(`SELECT count(*)::int calls, COALESCE(sum(input_tokens),0)::bigint input_tokens,
        COALESCE(sum(output_tokens),0)::bigint output_tokens, COALESCE(sum(cost_usd),0)::numeric cost_usd
        FROM usage_logs WHERE tenant_id=$1 AND created_at >= $2::timestamptz AND created_at < $2::timestamptz + interval '1 month'`, [session.tenantId, start]),
      db.query(`SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS "day", count(*)::int calls,
        sum(input_tokens + output_tokens)::bigint tokens, sum(cost_usd)::numeric cost_usd
        FROM usage_logs WHERE tenant_id=$1 AND created_at >= $2::timestamptz AND created_at < $2::timestamptz + interval '1 month'
        GROUP BY 1 ORDER BY 1`, [session.tenantId, start]),
      db.query(`SELECT ai_model, count(*)::int calls, sum(input_tokens + output_tokens)::bigint tokens, sum(cost_usd)::numeric cost_usd
        FROM usage_logs WHERE tenant_id=$1 AND created_at >= $2::timestamptz AND created_at < $2::timestamptz + interval '1 month'
        GROUP BY ai_model ORDER BY cost_usd DESC`, [session.tenantId, start]),
      db.query(`SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS "day", ai_model,
        count(*)::int calls, sum(input_tokens + output_tokens)::bigint tokens, sum(cost_usd)::numeric cost_usd
        FROM usage_logs WHERE tenant_id=$1 AND created_at >= $2::timestamptz AND created_at < $2::timestamptz + interval '1 month'
        GROUP BY 1, ai_model ORDER BY 1, cost_usd DESC`, [session.tenantId, start])
    ]);
    return { month, summary: summary.rows[0], daily: daily.rows, models: models.rows, daily_models: dailyModels.rows };
	  });
  app.get("/usage/credits", async (request, reply) => {
    await requireRootWorkspace(request);
    void reply.header("cache-control", "no-store");
    if (!config.OPENROUTER_MANAGEMENT_API_KEY) {
      return { status: "not_configured" as const };
    }
    try {
      const credits = await fetchOpenRouterCreditBalance(config);
      return {
        status: "available" as const,
        total_credits: credits.totalCredits,
        total_usage: credits.totalUsage,
        balance: credits.balance,
        checked_at: new Date().toISOString()
      };
    } catch (error) {
      request.log.warn({ err: error }, "OpenRouter credit balance lookup failed");
      return reply.status(502).send({ error: "Não foi possível consultar o saldo da OpenRouter" });
    }
  });
  app.get("/usage/export", { config: { rateLimit: HTTP_RATE_LIMITS.export } }, async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const requested = monthSchema.parse((request.query as { month?: string }).month);
    const month = requested ?? new Date().toISOString().slice(0, 7);
    const start = `${month}-01T00:00:00.000Z`;
    const result = await db.query(
      `SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS "day",
              ai_model,
              count(*)::int calls,
              sum(input_tokens + output_tokens)::bigint tokens,
              sum(cost_usd)::numeric cost_usd
       FROM usage_logs
       WHERE tenant_id=$1 AND created_at >= $2::timestamptz AND created_at < $2::timestamptz + interval '1 month'
       GROUP BY 1,ai_model
       ORDER BY 1,cost_usd DESC`,
      [session.tenantId, start]
    );
    const rows = [
      ["data", "modelo", "chamadas", "tokens", "custo_usd"],
      ...result.rows.map((row) => [row.day, row.ai_model, row.calls, row.tokens, row.cost_usd])
    ];
    return reply
      .type("text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="uso-ia-${month}.csv"`)
      .send(rows.map((row) => row.map(csvCell).join(",")).join("\n"));
  });
  app.put("/agent", async (request, reply) => {
    const session = await requireRootWorkspace(request); const body = agentSchema.parse(request.body);
    const modelParams = { temperature: body.temperature, max_tokens: body.maxTokens, reasoning_effort: body.reasoningEffort };
    const enabledTools = body.enabledTools ?? AVAILABLE_TOOL_NAMES;
    const targetSessionId = body.sessionId ?? null;
    try {
      const saved = await withTenantTransaction(db, session.tenantId, async (client) => {
        if (targetSessionId) {
          const owned = await client.query(
            "SELECT id FROM whatsapp_sessions WHERE id=$2 AND tenant_id=$1 AND archived_at IS NULL",
            [session.tenantId, targetSessionId]
          );
          if (!owned.rows[0]) throw Object.assign(new Error("Conexão não encontrada"), { statusCode: 404 });
        }
        // Trava a linha-alvo: sem isso dois salvos simultâneos podem publicar
        // versões concorrentes e disputar o índice de versão ativa.
        // Não há UNIQUE nas linhas compartilhadas (bases legadas podem ter mais
        // de uma), então a escolha precisa ser determinística como no runtime.
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM agent_configs
           WHERE tenant_id=$1 AND session_id IS NOT DISTINCT FROM $2::uuid
           ORDER BY updated_at DESC, id
           LIMIT 1
           FOR UPDATE`,
          [session.tenantId, targetSessionId]
        );
        let configId = existing.rows[0]?.id ?? null;
        if (!configId) {
          if (!targetSessionId) throw Object.assign(new Error("Agente não encontrado"), { statusCode: 404 });
          // Primeiro override desta conexão: nasce a partir do que for enviado.
          configId = (await client.query<{ id: string }>(
            `INSERT INTO agent_configs(tenant_id,session_id,name,system_prompt,ai_model,model_params,enabled_tools,is_active,updated_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()) RETURNING id`,
            [session.tenantId, targetSessionId, "Agente da conexão", body.systemPrompt, body.aiModel, modelParams, JSON.stringify(enabledTools), body.isActive]
          )).rows[0].id;
        }
        // O runtime lê agent_config_versions, não a coluna legada: sem publicar
        // versão, salvar o prompt no painel não muda o que a IA responde.
        await client.query(
          `UPDATE agent_config_versions SET status='retired', retired_at=now()
           WHERE agent_config_id=$1 AND status='active'`,
          [configId]
        );
        const version = await client.query<{ id: string }>(
          `INSERT INTO agent_config_versions(
             tenant_id,agent_config_id,version_number,source,status,
             system_prompt,ai_model,model_params,enabled_tools,created_by_user_id,activated_at
           )
           SELECT $1,$2,COALESCE(max(version_number),0)+1,'manual','active',$3,$4,$5,$6,$7,now()
           FROM agent_config_versions WHERE agent_config_id=$2
           RETURNING id`,
          [session.tenantId, configId, body.systemPrompt, body.aiModel, modelParams, JSON.stringify(enabledTools), session.userId]
        );
        const updated = await client.query(
          `UPDATE agent_configs
           SET system_prompt=$3, ai_model=$4, model_params=$5, enabled_tools=$6, is_active=$7,
               active_version_id=$8, updated_at=now()
           WHERE id=$2 AND tenant_id=$1
           RETURNING id, ai_model, enabled_tools, updated_at, session_id`,
          [session.tenantId, configId, body.systemPrompt, body.aiModel, modelParams, JSON.stringify(enabledTools), body.isActive, version.rows[0].id]
        );
        return updated.rows[0] ?? null;
      });
      if (!saved) return reply.status(404).send({ error: "Agente não encontrado" });
      return reply.send({ agent: { ...saved, scope: targetSessionId ? "connection" : "shared" } });
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404) return reply.status(404).send({ error: (error as Error).message });
      throw error;
    }
  });
  app.delete("/agent/override/:sessionId", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(request.params);
    const removed = await db.query(
      "DELETE FROM agent_configs WHERE tenant_id=$1 AND session_id=$2 RETURNING id",
      [session.tenantId, sessionId]
    );
    if (!removed.rows[0]) return reply.status(404).send({ error: "Esta conexão não tem prompt próprio" });
    return reply.send({ ok: true });
  });
  app.patch("/agent/status", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const body = agentStatusSchema.parse(request.body);
    const result = await db.query<{ id: string; is_active: boolean }>(
      `UPDATE agent_configs SET is_active=$2, updated_at=now()
       WHERE id=(SELECT id FROM agent_configs
                 WHERE tenant_id=$1 AND session_id IS NOT DISTINCT FROM $3::uuid
                 ORDER BY updated_at DESC LIMIT 1)
       RETURNING id,is_active`,
      [session.tenantId, body.isActive, body.sessionId ?? null]
    );
    if (!result.rows[0]) return reply.status(404).send({ error: "Agente não encontrado" });
    await auditLog({
      actorUserId: session.userId,
      workspaceId: session.tenantId,
      actorScope: session.actorScope,
      action: body.isActive ? "agent.enabled" : "agent.disabled",
      resourceType: "agent",
      resourceId: result.rows[0].id,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    return { agent: result.rows[0] };
  });

  app.get("/signature", async (request) => {
    const session = await requirePermission(request, "signature.read");
    const result = await db.query<{ enabled: boolean; format: SignatureFormat; name_style: SignatureNameStyle }>(
      "SELECT enabled,format,name_style FROM attendant_signature_settings WHERE tenant_id=$1",
      [session.tenantId]
    );
    return { signature: result.rows[0] ?? { enabled: false, format: "name_colon", name_style: "full" } };
  });
  app.put("/signature", async (request) => {
    const session = await requirePermission(request, "signature.manage");
    const body = signatureSettingsSchema.parse(request.body);
    await db.query(
      `INSERT INTO attendant_signature_settings(tenant_id,enabled,format,name_style)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(tenant_id) DO UPDATE SET enabled=$2,format=$3,name_style=$4,updated_at=now()`,
      [session.tenantId, body.enabled, body.format, body.nameStyle]
    );
    return { signature: { enabled: body.enabled, format: body.format, name_style: body.nameStyle } };
  });
  app.patch("/conversations/:id/signature", async (request, reply) => {
    const session = await requirePermission(request, "conversations.reply");
    const { id } = idParams.parse(request.params);
    const body = conversationSignatureSchema.parse(request.body);
    const scope = await resolveCaseScope(db, session);
    const result = await db.query(
      `UPDATE conversations conversation
       SET signature_enabled=$3
       WHERE conversation.id=$1 AND conversation.tenant_id=$2
         AND (${conversationScopeCondition(scope, "conversation", "$4")})
       RETURNING signature_enabled`,
      [id, session.tenantId, body.enabled, scope.userId]
    );
    if (!result.rows[0]) return reply.status(404).send({ error: "Conversa não encontrada" });
    return { signature_enabled: result.rows[0].signature_enabled };
  });

  app.get("/humanizer", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const result = await db.query<{ humanizer_config: unknown }>("SELECT humanizer_config FROM tenant_ai_settings WHERE tenant_id=$1", [session.tenantId]);
    if (!result.rows[0]) return reply.status(404).send({ error: "Configuração do tenant não encontrada" });
    return { humanizer: migrateHumanizerConfig(result.rows[0].humanizer_config) };
  });
  app.put("/humanizer", async (request) => {
    const session = await requireRootWorkspace(request);
    const humanizer = humanizerSchema.parse(request.body);
    await db.query(`INSERT INTO tenant_ai_settings(tenant_id,openrouter_api_key_encrypted,media_fallback_audio,media_fallback_image,media_fallback_document,humanizer_config)
      VALUES($1,NULL,$2,$3,$4,$5) ON CONFLICT(tenant_id) DO UPDATE SET humanizer_config=$5,updated_at=now()`,
      [session.tenantId, DEFAULT_MEDIA_FALLBACK.audio, DEFAULT_MEDIA_FALLBACK.image, DEFAULT_MEDIA_FALLBACK.document, humanizer]);
    return { humanizer };
  });

  app.get("/ai-follow-ups/media", async (request) => {
    const session = await requireRootWorkspace(request);
    return { media: await new FollowUpMediaRepository(db).list(session.tenantId) };
  });

  app.get("/ai-follow-ups/media/:id/content", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const { id } = idParams.parse(request.params);
    const content = await new FollowUpMediaRepository(db).content(session.tenantId, id);
    if (!content) return reply.status(404).send({ error: "Imagem não encontrada" });
    return reply.header("content-type", content.mimeType)
      .header("cache-control", "private, max-age=300")
      .header("x-content-type-options", "nosniff")
      .send(content.data);
  });

  app.post("/ai-follow-ups/media", {
    bodyLimit: 24 * 1024 * 1024,
    config: { rateLimit: HTTP_RATE_LIMITS.upload }
  }, async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const body = followUpMediaBodySchema.parse(request.body);
    const decoded = decodeFollowUpMedia(body);
    const media = await new FollowUpMediaRepository(db).create({
      tenantId: session.tenantId,
      userId: session.userId,
      name: body.name,
      description: body.description,
      ...decoded
    });
    await auditLog({
      actorUserId: session.userId,
      workspaceId: session.tenantId,
      actorScope: session.actorScope,
      action: "agent.follow_up.media.create",
      resourceType: "agent_follow_up_media",
      resourceId: media.id,
      metadata: { name: media.name, mimeType: media.mime_type, sizeBytes: media.size_bytes },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    return reply.status(201).send({ media });
  });

  app.delete("/ai-follow-ups/media/:id", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const { id } = idParams.parse(request.params);
    const removed = await new FollowUpMediaRepository(db).remove(session.tenantId, id);
    if (removed === "in_use") {
      return reply.status(409).send({ error: "Remova esta imagem das tentativas antes de excluí-la" });
    }
    if (removed === "missing") return reply.status(404).send({ error: "Imagem não encontrada" });
    await auditLog({
      actorUserId: session.userId,
      workspaceId: session.tenantId,
      actorScope: session.actorScope,
      action: "agent.follow_up.media.delete",
      resourceType: "agent_follow_up_media",
      resourceId: id,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    return reply.status(204).send();
  });

  app.get("/ai-follow-ups/settings", async (request) => {
    const session = await requireRootWorkspace(request);
    const result = await db.query<{
      ai_follow_up_enabled: boolean;
      ai_follow_up_max_count: number;
      ai_follow_up_interval_minutes: number;
      ai_follow_up_delays_minutes: number[];
      ai_follow_up_delivery: unknown;
    }>(
      `SELECT ai_follow_up_enabled,ai_follow_up_max_count,ai_follow_up_interval_minutes,
              ai_follow_up_delays_minutes,ai_follow_up_delivery
       FROM tenant_ai_settings WHERE tenant_id=$1`,
      [session.tenantId]
    );
    const row = result.rows[0];
    const delaysMinutes = row?.ai_follow_up_delays_minutes ?? [120, 1440, 4320];
    const deliveryResult = z.array(z.discriminatedUnion("type", [
      z.object({ type: z.literal("text") }),
      z.object({ type: z.literal("image"), assetId: z.string().uuid() }),
      z.object({ type: z.literal("audio"), assetId: z.string().uuid() }),
      z.object({ type: z.literal("video"), assetId: z.string().uuid() }),
      z.object({ type: z.literal("sticker"), assetId: z.string().uuid() })
    ])).safeParse(row?.ai_follow_up_delivery);
    const delivery = deliveryResult.success && deliveryResult.data.length === delaysMinutes.length
      ? deliveryResult.data
      : delaysMinutes.map(() => ({ type: "text" as const }));
    return {
      settings: {
        enabled: row?.ai_follow_up_enabled ?? false,
        delaysMinutes,
        delivery,
        // Campos derivados mantidos enquanto integrações antigas migram.
        maxCount: delaysMinutes.length,
        intervalMinutes: delaysMinutes[0]
      }
    };
  });

  app.put("/ai-follow-ups/settings", async (request) => {
    const session = await requireRootWorkspace(request);
    const settings = aiFollowUpSettingsSchema.parse(request.body);
    await new FollowUpMediaRepository(db).validateDelivery(session.tenantId, settings.delivery);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO tenant_ai_settings(
           tenant_id,openrouter_api_key_encrypted,media_fallback_audio,media_fallback_image,media_fallback_document,
           ai_follow_up_enabled,ai_follow_up_max_count,ai_follow_up_interval_minutes,ai_follow_up_delays_minutes,
           ai_follow_up_delivery
         ) VALUES($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT(tenant_id) DO UPDATE SET
           ai_follow_up_enabled=$5,
           ai_follow_up_max_count=$6,
           ai_follow_up_interval_minutes=$7,
           ai_follow_up_delays_minutes=$8,
           ai_follow_up_delivery=$9,
           updated_at=now()`,
        [session.tenantId, DEFAULT_MEDIA_FALLBACK.audio, DEFAULT_MEDIA_FALLBACK.image,
          DEFAULT_MEDIA_FALLBACK.document, settings.enabled, settings.delaysMinutes.length,
          settings.delaysMinutes[0], settings.delaysMinutes, JSON.stringify(settings.delivery)]
      );
      await client.query(
        `UPDATE ai_follow_up_schedules f SET
           sequence_version=f.sequence_version+1,
           status=CASE
             WHEN NOT $2::boolean THEN 'cancelled'
             WHEN f.follow_up_count>=cardinality($3::integer[]) THEN 'completed'
             WHEN NOT c.ai_active OR c.status<>'open' THEN 'cancelled'
             WHEN (SELECT id FROM messages WHERE conversation_id=f.conversation_id AND NOT (sender='agent' AND media_is_sticker) ORDER BY created_at DESC,id DESC LIMIT 1)
                    IS DISTINCT FROM f.last_agent_message_id THEN 'cancelled'
             WHEN f.sequence_started_at+make_interval(mins => ($3::integer[])[f.follow_up_count+1])<=now() THEN 'cancelled'
             ELSE 'scheduled'
           END,
           next_run_at=CASE
             WHEN $2::boolean AND f.follow_up_count<cardinality($3::integer[]) AND c.ai_active AND c.status='open'
               AND (SELECT id FROM messages WHERE conversation_id=f.conversation_id AND NOT (sender='agent' AND media_is_sticker) ORDER BY created_at DESC,id DESC LIMIT 1)
                    =f.last_agent_message_id
               AND f.sequence_started_at+make_interval(mins => ($3::integer[])[f.follow_up_count+1])>now()
             THEN f.sequence_started_at+make_interval(mins => ($3::integer[])[f.follow_up_count+1])
             ELSE NULL
           END,
           processing_started_at=NULL,
           failure_count=0,
           last_error=NULL,
           cancellation_reason=CASE
             WHEN NOT $2::boolean THEN 'configuration_disabled'
             WHEN f.follow_up_count>=cardinality($3::integer[]) THEN 'maximum_reached'
             WHEN NOT c.ai_active OR c.status<>'open' THEN 'conversation_inactive'
             WHEN (SELECT id FROM messages WHERE conversation_id=f.conversation_id AND NOT (sender='agent' AND media_is_sticker) ORDER BY created_at DESC,id DESC LIMIT 1)
                    IS DISTINCT FROM f.last_agent_message_id THEN 'conversation_changed'
             WHEN f.sequence_started_at+make_interval(mins => ($3::integer[])[f.follow_up_count+1])<=now() THEN 'cadence_configuration_overdue'
             ELSE NULL
           END,
           updated_at=now()
         FROM conversations c
         WHERE f.tenant_id=$1 AND c.id=f.conversation_id AND c.tenant_id=f.tenant_id
           AND f.status IN ('scheduled','processing')`,
        [session.tenantId, settings.enabled, settings.delaysMinutes]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await auditLog({
      actorUserId: session.userId,
      workspaceId: session.tenantId,
      actorScope: session.actorScope,
      action: "agent.follow_up.settings.update",
      resourceType: "agent_follow_up_settings",
      resourceId: session.tenantId,
      metadata: settings,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    return { settings };
  });

  app.get("/conversations", async (request) => {
    const session = await requirePermission(request, "conversations.read");
    const scope = await resolveCaseScope(db, session);
    const { filter, q, queue_id, session_id, unread, pending_action } = conversationsQuerySchema.parse(request.query);
    const condition = filter === "human" ? "AND c.status='open' AND c.ai_active=false"
      : filter === "ai" ? "AND c.status='open' AND c.ai_active=true"
        : filter === "mine" ? "AND c.status='open' AND c.assigned_user_id=$3"
          : filter === "unassigned" ? "AND c.status='open' AND c.ai_active=false AND c.assigned_user_id IS NULL AND c.handoff_reason IS DISTINCT FROM 'manually_paused'"
            : filter === "scheduled" ? `AND EXISTS (
                SELECT 1
                FROM scheduling_leads scheduled_lead
                JOIN scheduling_appointments scheduled_appointment
                  ON scheduled_appointment.tenant_id=scheduled_lead.tenant_id
                 AND scheduled_appointment.lead_id=scheduled_lead.id
                 AND scheduled_appointment.status IN ('confirmado','reagendado')
                WHERE scheduled_lead.tenant_id=c.tenant_id
                  AND scheduled_lead.id=c.lead_id
              )`
              : filter === "resolved" ? "AND c.status='closed'" : "AND c.status='open'";
    const filterConditions = [
      "AND ($4::uuid IS NULL OR c.queue_id=$4)",
      "AND ($5::uuid IS NULL OR c.session_id=$5)",
      unread === "true" ? "AND EXISTS (SELECT 1 FROM messages unread_message WHERE unread_message.conversation_id=c.id AND unread_message.sender='contact' AND unread_message.created_at > COALESCE(c.last_read_at,'-infinity'))" : unread === "false" ? "AND NOT EXISTS (SELECT 1 FROM messages read_message WHERE read_message.conversation_id=c.id AND read_message.sender='contact' AND read_message.created_at > COALESCE(c.last_read_at,'-infinity'))" : "",
      pending_action === "true" ? "AND lead.next_action_at IS NOT NULL AND lead.next_action_at <= now()+interval '15 minutes'" : pending_action === "false" ? "AND (lead.next_action_at IS NULL OR lead.next_action_at > now()+interval '15 minutes')" : ""
    ].join(" ");
    const search = "AND ($2::text = '' OR strpos(lower(COALESCE(c.contact_name,'')),lower($2)) > 0 OR strpos(c.contact_phone,$2) > 0)";
    const values = [session.tenantId, q ?? "", session.userId, queue_id ?? null, session_id ?? null];
    const result = await db.query(`SELECT c.id, c.session_id, c.lead_id, c.contact_phone, c.contact_name,
      c.contact_avatar_url avatar_url, c.ai_active, c.handoff_reason,
      c.status, c.last_message_at, c.contact_jid, c.assigned_user_id, c.claimed_at, c.resolved_at,
      c.contact_presence, c.contact_presence_updated_at, c.contact_last_seen_at, c.signature_enabled,
      c.queue_id, qqueue.name queue_name, qqueue.color queue_color, qqueue.position queue_position,
      qqueue.is_initial queue_is_initial, qqueue.is_resolved queue_is_resolved, qqueue.archived_at queue_archived_at,
      ws.channel,
      u.email assigned_user_email,lead.status lead_status,lead.updated_at lead_updated_at,
      lead.next_action,lead.next_action_at,
      (lead.next_action_at IS NOT NULL AND lead.next_action_at <= now()) next_action_due,
      lead.source lead_source, lead.campaign lead_campaign,
      lead.facebook_attribution,
      jsonb_build_object(
        'id',stage.id,'name',stage.name,'color',stage.color,'position',stage.position,
        'capacity_target',stage.capacity_target,'technical_status',stage.technical_status,
        'is_default',stage.is_default
      ) pipeline_stage,
      COALESCE(tags.items,'[]'::jsonb) tags,
      NULLIF(split_part(btrim(u.name), ' ', 1), '') assigned_user_first_name,
      floor(extract(epoch FROM (now() - c.last_message_at)) / 60)::int waiting_minutes,
      CASE WHEN last_msg.content <> '' THEN last_msg.content
              WHEN last_msg.media_type='audio' THEN 'Mensagem de áudio'
              WHEN last_msg.media_is_sticker THEN 'Figurinha'
              WHEN last_msg.media_type='image' THEN 'Imagem'
              WHEN last_msg.media_type='document' THEN COALESCE(last_msg.media_file_name,'Documento')
              ELSE last_msg.content END last_message,
      last_msg.sender last_message_sender,
      last_msg.status last_message_status,
      COALESCE(unread.count,0)::int unread_count
      FROM conversations c
      LEFT JOIN users u ON u.id=c.assigned_user_id
      LEFT JOIN conversation_queues qqueue ON qqueue.id=c.queue_id AND qqueue.tenant_id=c.tenant_id
      LEFT JOIN whatsapp_sessions ws ON ws.id=c.session_id AND ws.tenant_id=c.tenant_id
      LEFT JOIN LATERAL (
        SELECT content, media_type, media_is_sticker, media_file_name, sender, status
        FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1
      ) last_msg ON true
      LEFT JOIN LATERAL (
        SELECT count(*) count FROM messages
        WHERE conversation_id=c.id AND sender='contact' AND created_at > COALESCE(c.last_read_at,'-infinity')
      ) unread ON true
      JOIN scheduling_leads lead ON lead.id=c.lead_id AND lead.tenant_id=c.tenant_id
      JOIN pipeline_stages stage ON stage.id=lead.pipeline_stage_id AND stage.tenant_id=lead.tenant_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'id',tag.id,'name',tag.name,'color',tag.color,'archived',tag.archived_at IS NOT NULL
        ) ORDER BY lower(tag.name),tag.id) items
        FROM lead_tag_assignments assignment
        JOIN lead_tags tag ON tag.tenant_id=assignment.tenant_id AND tag.id=assignment.tag_id
        WHERE assignment.tenant_id=lead.tenant_id AND assignment.lead_id=lead.id
      ) tags ON true
      WHERE c.tenant_id=$1
        AND (${conversationScopeCondition(scope, "c", "$3")})
        ${condition} ${filterConditions} ${search}
      ORDER BY c.last_message_at DESC LIMIT 50`, values);
    for (const conversation of result.rows.slice(0, 20)) {
      if (!conversation.avatar_url && conversation.session_id && conversation.contact_phone) {
        void whatsapp.refreshContactAvatar(conversation.session_id, conversation.contact_phone).catch((error) => {
          app.log.debug({ err: error, conversationId: conversation.id }, "Could not refresh contact avatar from conversation list");
        });
      }
    }
    return { conversations: result.rows };
  });
  app.get("/conversations/pending-actions", async (request) => {
    const session = await requirePermission(request, "conversations.read");
    const scope = await resolveCaseScope(db, session);
    const result = await db.query(`
      WITH pending AS (
        SELECT c.id,c.session_id,c.lead_id,c.contact_phone,c.contact_name,c.contact_avatar_url avatar_url,
          c.ai_active,c.handoff_reason,c.status,c.last_message_at,c.assigned_user_id,c.queue_id,
          ws.channel,u.email assigned_user_email,lead.next_action,lead.next_action_at,
          (lead.next_action_at <= now()) next_action_due,
          (lead.next_action_at <= now()) overdue,
          count(*) OVER ()::int total,
          count(*) FILTER (WHERE lead.next_action_at <= now()) OVER ()::int overdue_total
        FROM conversations c
        LEFT JOIN users u ON u.id=c.assigned_user_id
        LEFT JOIN whatsapp_sessions ws ON ws.id=c.session_id AND ws.tenant_id=c.tenant_id
        JOIN scheduling_leads lead ON lead.id=c.lead_id AND lead.tenant_id=c.tenant_id
        WHERE c.tenant_id=$1
          AND c.status='open'
          AND (${conversationScopeCondition(scope, "c", "$2")})
          AND lead.next_action_at IS NOT NULL
          AND lead.next_action_at <= now()+interval '15 minutes'
      )
      SELECT * FROM pending ORDER BY next_action_at ASC,id LIMIT 50`,
      [session.tenantId, session.userId]
    );
    const first = result.rows[0] as { total?: number; overdue_total?: number } | undefined;
    return {
      conversations: result.rows,
      total: Number(first?.total ?? 0),
      overdue_total: Number(first?.overdue_total ?? 0)
    };
  });
  app.get("/conversations/unread", async (request) => {
    const session = await requirePermission(request, "conversations.read");
    const scope = await resolveCaseScope(db, session);
    const result = await db.query(`
      SELECT c.id, c.contact_phone, c.contact_name, c.contact_avatar_url avatar_url,
        c.last_message_at, unread.count unread_count,
        (SELECT CASE WHEN content <> '' THEN content
                WHEN media_type='audio' THEN 'Mensagem de áudio'
                WHEN media_is_sticker THEN 'Figurinha'
                WHEN media_type='image' THEN 'Imagem'
                WHEN media_type='document' THEN COALESCE(media_file_name,'Documento')
                ELSE content END
         FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1) last_message
      FROM conversations c
      JOIN LATERAL (
        SELECT count(*) count FROM messages
        WHERE conversation_id=c.id AND sender='contact' AND created_at > COALESCE(c.last_read_at,'-infinity')
      ) unread ON unread.count > 0
      WHERE c.tenant_id=$1 AND c.status='open'
        AND (${conversationScopeCondition(scope, "c", "$2")})
      ORDER BY c.last_message_at DESC LIMIT 20`,
      [session.tenantId, scope.userId]
    );
    return { conversations: result.rows };
  });
  app.get("/conversations/unread-counts", async (request) => {
    const session = await requirePermission(request, "conversations.read");
    const scope = await resolveCaseScope(db, session);
    const hasWorkspaceScope = scope.type === "workspace";
    const values = [session.tenantId, scope.userId];
    const result = await db.query<{ human: number; ai: number; scheduled: number; resolved: number; mine: number }>(`
      SELECT
        COALESCE(SUM(unread) FILTER (WHERE status='open' AND ai_active=false),0)::int human,
        COALESCE(SUM(unread) FILTER (WHERE status='open' AND ai_active=true),0)::int ai,
        COALESCE(SUM(unread) FILTER (WHERE status='open' AND scheduled),0)::int scheduled,
        COALESCE(SUM(unread) FILTER (WHERE status='closed'),0)::int resolved,
        COALESCE(SUM(unread) FILTER (WHERE status='open'),0)::int mine
      FROM (
        SELECT c.status, c.ai_active,
          EXISTS (
            SELECT 1 FROM scheduling_leads scheduled_lead
            JOIN scheduling_appointments scheduled_appointment
              ON scheduled_appointment.tenant_id=scheduled_lead.tenant_id
             AND scheduled_appointment.lead_id=scheduled_lead.id
             AND scheduled_appointment.status IN ('confirmado','reagendado')
            WHERE scheduled_lead.tenant_id=c.tenant_id AND scheduled_lead.id=c.lead_id
          ) scheduled,
          (SELECT count(*) FROM messages m WHERE m.conversation_id=c.id AND m.sender='contact'
             AND m.created_at > COALESCE(c.last_read_at,'-infinity')) unread
        FROM conversations c
        WHERE c.tenant_id=$1 AND (${conversationScopeCondition(scope, "c", "$2")})
      ) c`, values);
    const row = result.rows[0] ?? { human: 0, ai: 0, scheduled: 0, resolved: 0, mine: 0 };
    return hasWorkspaceScope
      ? { human: row.human, ai: row.ai, scheduled: row.scheduled, resolved: row.resolved }
      : { mine: row.mine };
  });
  app.patch("/conversations/:id/read", async (request, reply) => {
    const session = await requirePermission(request, "conversations.read");
    const { id } = idParams.parse(request.params);
    if (!await canAccessConversation(db, session, id)) {
      return reply.status(404).send({ error: "Conversa não encontrada" });
    }
    await db.query(`UPDATE conversations SET last_read_at=now() WHERE id=$1 AND tenant_id=$2`, [id, session.tenantId]);
    return { conversation_id: id };
  });
  app.patch("/conversations/:id/notification-mute", async (request, reply) => {
    const session = await requirePermission(request, "conversations.read");
    const { id } = idParams.parse(request.params);
    const { muted } = notificationMuteSchema.parse(request.body);
    if (!await canAccessConversation(db, session, id)) {
      return reply.status(404).send({ error: "Conversa não encontrada" });
    }
    if (muted) {
      await db.query(
        `INSERT INTO panel_notification_conversation_mutes(tenant_id,user_id,conversation_id)
         VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [session.tenantId, session.userId, id]
      );
    } else {
      await db.query(
        `DELETE FROM panel_notification_conversation_mutes
         WHERE tenant_id=$1 AND user_id=$2 AND conversation_id=$3`,
        [session.tenantId, session.userId, id]
      );
    }
    return { conversation_id: id, muted };
  });
  app.patch("/conversations/:id/contact", async (request, reply) => {
    const session = await requirePermission(request, "conversations.reply");
    const { id } = idParams.parse(request.params);
    const { name } = contactUpdateSchema.parse(request.body);
    const scope = await resolveCaseScope(db, session);
    const updated = await withTenantTransaction(db, session.tenantId, async (client) => {
      const result = await client.query<{ contact_name: string; contact_phone: string; lead_id: string | null }>(
        `UPDATE conversations conversation SET contact_name=$1
         WHERE conversation.id=$2 AND conversation.tenant_id=$3
           AND (${conversationScopeCondition(scope, "conversation", "$4")})
         RETURNING contact_name,contact_phone,lead_id`,
        [name, id, session.tenantId, scope.userId]
      );
      if (!result.rows[0]) return null;
      await client.query(
        `UPDATE scheduling_leads lead
         SET name=$1,updated_at=now()
         WHERE lead.tenant_id=$2
           AND (lead.id=$3 OR regexp_replace(lead.phone,'\\D','','g')=regexp_replace($4,'\\D','','g'))`,
        [name, session.tenantId, result.rows[0].lead_id, result.rows[0].contact_phone]
      );
      await insertAuditLog(client, {
        actorUserId: session.userId,
        workspaceId: session.tenantId,
        actorScope: session.actorScope,
        action: "conversation.contact_updated",
        resourceType: "conversation",
        resourceId: id,
        metadata: { contactName: result.rows[0].contact_name },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
      return result.rows[0];
    });
    if (!updated) return reply.status(404).send({ error: "Conversa não encontrada" });
    return { conversation_id: id, contact_name: updated.contact_name };
  });
  app.delete("/conversations/:id/messages", async (request, reply) => {
    const session = await requirePermission(request, "conversations.reply");
    const { id } = idParams.parse(request.params);
    const scope = await resolveCaseScope(db, session);
    const cleared = await withTenantTransaction(db, session.tenantId, async (client) => {
      const conversation = await client.query<{ id: string }>(
        `SELECT conversation.id FROM conversations conversation
         WHERE conversation.id=$1 AND conversation.tenant_id=$2
           AND (${conversationScopeCondition(scope, "conversation", "$3")})
         FOR UPDATE`,
        [id, session.tenantId, scope.userId]
      );
      if (!conversation.rows[0]) return null;
      const deleted = await client.query<{ id: string }>(
        `DELETE FROM messages WHERE conversation_id=$1 RETURNING id`,
        [id]
      );
      await client.query(
        `UPDATE conversations SET last_message_at=created_at
         WHERE id=$1 AND tenant_id=$2`,
        [id, session.tenantId]
      );
      await insertAuditLog(client, {
        actorUserId: session.userId,
        workspaceId: session.tenantId,
        actorScope: session.actorScope,
        action: "conversation.messages_cleared",
        resourceType: "conversation",
        resourceId: id,
        metadata: { deletedCount: deleted.rowCount ?? 0 },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
      return { deletedCount: deleted.rowCount ?? 0 };
    });
    if (!cleared) return reply.status(404).send({ error: "Conversa não encontrada" });
    return { conversation_id: id, deleted_count: cleared.deletedCount };
  });
  app.get("/conversations/:id/assets", async (request, reply) => {
    const session = await requirePermission(request, "conversations.read");
    const { id } = idParams.parse(request.params);
    const scope = await resolveCaseScope(db, session);
    const { limit, before } = conversationAssetsQuerySchema.parse(request.query);
    const values: unknown[] = [id, session.tenantId, scope.userId];
    const cursorCondition = before
      ? (() => {
          values.push(before.createdAt, before.id);
          return "AND (message.created_at,message.id)<($4::timestamptz,$5::uuid)";
        })()
      : "";
    values.push(limit + 1);
    const result = await db.query<{ id: string | null; created_at: string | null; content: string | null; media_type: string | null; media_mime_type: string | null; media_file_name: string | null; media_size_bytes: number | null }>(
      `WITH visible_conversation AS MATERIALIZED (
         SELECT conversation.id
         FROM conversations conversation
         WHERE conversation.id=$1 AND conversation.tenant_id=$2
           AND (${conversationScopeCondition(scope, "conversation", "$3")})
       )
       SELECT message.id,
              to_char(message.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at,
              message.content,message.media_type,message.media_mime_type,
              message.media_file_name,message.media_size_bytes
       FROM visible_conversation conversation
       LEFT JOIN LATERAL (
         SELECT candidate.id,candidate.created_at,candidate.content,candidate.media_type,
                candidate.media_mime_type,candidate.media_file_name,candidate.media_size_bytes
         FROM messages candidate
         WHERE candidate.conversation_id=conversation.id ${cursorCondition.replaceAll("message.", "candidate.")}
           AND candidate.deleted_at IS NULL
           AND (candidate.media_type IN ('image','document') OR candidate.content ~* 'https?://')
         ORDER BY candidate.created_at DESC,candidate.id DESC
         LIMIT $${values.length}
       ) message ON true
       ORDER BY message.created_at DESC NULLS LAST,message.id DESC NULLS LAST`,
      values
    );
    if (!result.rows[0]) return reply.status(404).send({ error: "Conversa não encontrada" });
    const available = result.rows.filter((row): row is typeof row & { id: string; created_at: string; content: string } =>
      Boolean(row.id && row.created_at && row.content !== null)
    );
    const messages = available.slice(0, limit);
    return {
      messages,
      has_more: result.rows.length > limit,
      limit,
      next_cursor: messages.at(-1) ? encodeMessageCursor(messages.at(-1)!) : null
    };
  });
  app.get("/conversations/assignees", async (request) => {
    const session = await requirePermission(request, "conversations.reply");
    const result = await db.query(
      `SELECT DISTINCT u.id, u.email
       FROM scheduling_google_meet_closers pool
       JOIN workspace_members m
         ON m.id=pool.member_id AND m.workspace_id=pool.tenant_id AND m.status='active'
       JOIN users u ON u.id=m.user_id AND u.status='active'
       WHERE pool.tenant_id=$1
         AND EXISTS (
           SELECT 1 FROM workspace_role_permissions permission
           WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.read'
         )
         AND EXISTS (
           SELECT 1 FROM workspace_role_permissions permission
           WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.reply'
         )
       ORDER BY u.email`,
      [session.tenantId]
    );
    return { assignees: result.rows };
  });
  app.get("/conversations/:id/messages/v2", async (request, reply) => {
    const session = await requirePermission(request, "conversations.read");
    const { id } = idParams.parse(request.params);
    const scope = await resolveCaseScope(db, session);
    const conversation = await db.query(`SELECT c.id, c.session_id, c.lead_id, c.contact_phone, c.contact_name, c.contact_jid,
      c.contact_avatar_url avatar_url,
      c.ai_active, c.handoff_reason, c.status, c.assigned_user_id, c.claimed_at, c.resolved_at,
      c.facebook_attribution,
      c.contact_presence, c.contact_presence_updated_at, c.contact_last_seen_at, c.signature_enabled,
      ws.channel,
      u.email assigned_user_email,lead.status lead_status,lead.updated_at lead_updated_at,
      lead.source lead_source, lead.campaign lead_campaign,
      lead.next_action, lead.next_action_at,
      COALESCE(interest_category.name, lead.interest_category_id) interest,
      jsonb_build_object('id',stage.id,'name',stage.name,'color',stage.color,'position',stage.position,
        'capacity_target',stage.capacity_target,'technical_status',stage.technical_status,'is_default',stage.is_default) pipeline_stage,
      COALESCE(tags.items,'[]'::jsonb) tags
      FROM conversations c
      JOIN whatsapp_sessions ws ON ws.id=c.session_id AND ws.tenant_id=c.tenant_id
      LEFT JOIN users u ON u.id=c.assigned_user_id
      JOIN scheduling_leads lead ON lead.id=c.lead_id AND lead.tenant_id=c.tenant_id
      JOIN pipeline_stages stage ON stage.id=lead.pipeline_stage_id AND stage.tenant_id=lead.tenant_id
      LEFT JOIN scheduling_categories interest_category
        ON interest_category.tenant_id=lead.tenant_id AND interest_category.id=lead.interest_category_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('id',tag.id,'name',tag.name,'color',tag.color,'archived',tag.archived_at IS NOT NULL) ORDER BY lower(tag.name),tag.id) items
        FROM lead_tag_assignments assignment
        JOIN lead_tags tag ON tag.tenant_id=assignment.tenant_id AND tag.id=assignment.tag_id
        WHERE assignment.tenant_id=lead.tenant_id AND assignment.lead_id=lead.id
      ) tags ON true
      WHERE c.id=$1 AND c.tenant_id=$2
        AND (${conversationScopeCondition(scope, "c", "$3")})`, [id, session.tenantId, scope.userId]);
    if (!conversation.rows[0]) return reply.status(404).send({ error: "Conversa não encontrada" });
    if (!await isFeatureFlagEnabled(db, session.tenantId, "conversations_delta_v2")) {
      return reply.status(409).send(
        featureFlagDisabled("conversations_delta_v2", `/conversations/${id}/messages`)
      );
    }

    const query = conversationMessagesV2QuerySchema.parse(request.query);
    const direction = query.after ? "after" : query.before ? "before" : "initial";
    const cursor = query.after ?? query.before;
    const initialBoundary = direction === "initial"
      ? (await db.query<{ created_at: Date }>("SELECT statement_timestamp() created_at")).rows[0]
      : undefined;
    const ascending = direction === "after";
    const values: unknown[] = [id];
    let cursorCondition = "";
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      cursorCondition = `AND (m.created_at,m.id) ${ascending ? ">" : "<"} ($2::timestamptz,$3::uuid)`;
    }
    values.push(query.limit + 1);
    const limitParameter = `$${values.length}`;
    const result = await db.query<{
      id: string;
      sender: "contact" | "agent" | "human";
      content: string;
      media_type: "audio" | "image" | "document" | null;
      media_mime_type: string | null;
      media_file_name: string | null;
      media_size_bytes: number | null;
      media_is_sticker: boolean;
      ai_model_used: string | null;
      status: string;
      created_at: Date;
      sender_name: string | null;
      reaction_emoji: string | null;
      edited_at: Date | null;
      deleted_at: Date | null;
      deleted_for_everyone_at: Date | null;
      reply_to_message_id: string | null;
      reply_to_content: string | null;
      reply_to_sender: "contact" | "agent" | "human" | null;
    }>(
      `SELECT m.id, m.sender, m.content, m.media_type, m.media_mime_type, m.media_file_name, m.media_size_bytes, m.media_is_sticker,
              m.ai_model_used, m.status, m.created_at, COALESCE(su.name, su.email) sender_name,
              m.reaction_emoji, m.edited_at, m.deleted_at, m.deleted_for_everyone_at,
              reply.id reply_to_message_id, reply.content reply_to_content, reply.sender reply_to_sender
       FROM messages m LEFT JOIN users su ON su.id=m.sent_by_user_id
              LEFT JOIN messages reply
                ON reply.id=m.reply_to_message_id AND reply.conversation_id=m.conversation_id
       WHERE m.conversation_id=$1 ${cursorCondition}
       ORDER BY m.created_at ${ascending ? "ASC" : "DESC"},m.id ${ascending ? "ASC" : "DESC"}
       LIMIT ${limitParameter}`,
      values
    );
    const hasMore = result.rows.length > query.limit;
    const selectedRows = result.rows.slice(0, query.limit);
    const messages = ascending ? selectedRows : selectedRows.reverse();
    const aiTurn = await aiTurnProgressStore.get(session.tenantId, id);
    return {
      conversation: conversation.rows[0],
      messages,
      ai_turn: aiTurn,
      cursors: {
        before: messages[0] ? encodeMessageCursor(messages[0]) : null,
        after: messages.at(-1)
          ? encodeMessageCursor(messages.at(-1)!)
          : initialBoundary
            ? encodeMessageCursor({ ...initialBoundary, id: "00000000-0000-0000-0000-000000000000" })
            : null
      },
      page: {
        direction,
        limit: query.limit,
        has_more_before: direction !== "after" && hasMore,
        has_more_after: direction === "after" && hasMore
      }
    };
  });
  app.get("/conversations/:id/messages", async (request, reply) => {
    const session = await requirePermission(request, "conversations.read"); const { id } = idParams.parse(request.params);
    const scope = await resolveCaseScope(db, session);
    const conversation = await db.query(`SELECT c.id, c.session_id, c.lead_id, c.contact_phone, c.contact_name, c.contact_jid,
      c.contact_avatar_url avatar_url,
      c.ai_active, c.handoff_reason, c.status, c.assigned_user_id, c.claimed_at, c.resolved_at,
      c.facebook_attribution,
      c.contact_presence, c.contact_presence_updated_at, c.contact_last_seen_at, c.signature_enabled,
      ws.channel,
      u.email assigned_user_email,lead.status lead_status,lead.updated_at lead_updated_at,
      lead.source lead_source, lead.campaign lead_campaign,
      lead.next_action, lead.next_action_at,
      COALESCE(interest_category.name, lead.interest_category_id) interest,
      jsonb_build_object('id',stage.id,'name',stage.name,'color',stage.color,'position',stage.position,
        'capacity_target',stage.capacity_target,'technical_status',stage.technical_status,'is_default',stage.is_default) pipeline_stage,
      COALESCE(tags.items,'[]'::jsonb) tags
      FROM conversations c
      JOIN whatsapp_sessions ws ON ws.id=c.session_id AND ws.tenant_id=c.tenant_id
      LEFT JOIN users u ON u.id=c.assigned_user_id
      JOIN scheduling_leads lead ON lead.id=c.lead_id AND lead.tenant_id=c.tenant_id
      JOIN pipeline_stages stage ON stage.id=lead.pipeline_stage_id AND stage.tenant_id=lead.tenant_id
      LEFT JOIN scheduling_categories interest_category
        ON interest_category.tenant_id=lead.tenant_id AND interest_category.id=lead.interest_category_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('id',tag.id,'name',tag.name,'color',tag.color,'archived',tag.archived_at IS NOT NULL) ORDER BY lower(tag.name),tag.id) items
        FROM lead_tag_assignments assignment
        JOIN lead_tags tag ON tag.tenant_id=assignment.tenant_id AND tag.id=assignment.tag_id
        WHERE assignment.tenant_id=lead.tenant_id AND assignment.lead_id=lead.id
      ) tags ON true
      WHERE c.id=$1 AND c.tenant_id=$2
        AND (${conversationScopeCondition(scope, "c", "$3")})`, [id, session.tenantId, scope.userId]);
    if (!conversation.rows[0]) return reply.status(404).send({ error: "Conversa não encontrada" });
    const messages = await db.query(
      `SELECT m.id, m.sender, m.content, m.media_type, m.media_mime_type, m.media_file_name, m.media_size_bytes, m.media_is_sticker,
              m.ai_model_used, m.status, m.created_at, COALESCE(su.name, su.email) sender_name,
              m.reaction_emoji, m.edited_at, m.deleted_at, m.deleted_for_everyone_at,
              reply.id reply_to_message_id, reply.content reply_to_content, reply.sender reply_to_sender
       FROM messages m LEFT JOIN users su ON su.id=m.sent_by_user_id
              LEFT JOIN messages reply
                ON reply.id=m.reply_to_message_id AND reply.conversation_id=m.conversation_id
       WHERE m.conversation_id=$1 ORDER BY m.created_at LIMIT 500`,
      [id]
    );
    const aiTurn = await aiTurnProgressStore.get(session.tenantId, id);
    return { conversation: conversation.rows[0], messages: messages.rows, ai_turn: aiTurn };
  });
  app.get("/conversations/:id/messages/:messageId/media", async (request, reply) => {
    const session = await requirePermission(request, "conversations.read");
    const params = z.object({ id: z.string().uuid(), messageId: z.string().uuid() }).parse(request.params);
    const scope = await resolveCaseScope(db, session);
    const result = await db.query<{
      session_id: string;
      external_message_id: string | null;
      media_type: "audio" | "image" | "document" | null;
      media_mime_type: string | null;
      media_file_name: string | null;
    }>(
      `SELECT c.session_id,m.external_message_id,m.media_type,m.media_mime_type,m.media_file_name
       FROM messages m JOIN conversations c ON c.id=m.conversation_id
       WHERE c.id=$1 AND m.id=$2 AND c.tenant_id=$3
         AND m.deleted_at IS NULL
         AND (${conversationScopeCondition(scope, "c", "$4")})`,
      [params.id, params.messageId, session.tenantId, scope.userId]
    );
    const media = result.rows[0];
    if (!media?.external_message_id || !media.media_type) return reply.status(404).send({ error: "Mídia não encontrada" });
    const downloaded = await whatsapp.downloadMedia(media.session_id, media.external_message_id);
    const mimeType = safeMediaResponseMime(media.media_type, downloaded.mimeType || media.media_mime_type || "application/octet-stream");
    const rawFileName = downloaded.fileName || media.media_file_name || `${params.messageId}.${media.media_type === "image" ? "jpg" : media.media_type === "audio" ? "ogg" : "bin"}`;
    const fileName = rawFileName.replace(/[\\/\r\n\u0000-\u001f\u007f]/g, "_").slice(0, 180);
    const disposition = media.media_type === "document" || mimeType === "application/octet-stream" ? "attachment" : "inline";
    return reply
      .header("content-type", mimeType)
      .header("content-disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      .header("cache-control", "private, max-age=300")
      .send(Buffer.from(downloaded.base64.replace(/^data:[^;,]+;base64,/i, ""), "base64"));
  });
  app.patch("/conversations/:id/reactivate", async (request, reply) => {
    const session = await requirePermission(request, "conversations.reactivate"); const { id } = idParams.parse(request.params);
    const scope = await resolveCaseScope(db, session);
    const reactivated = await withTenantTransaction(db, session.tenantId, async (client) => {
      const current = await client.query<{ id: string }>(
        `SELECT conversation.id FROM conversations conversation
         WHERE conversation.id=$1 AND conversation.tenant_id=$2
           AND (${conversationScopeCondition(scope, "conversation", "$3")})
         FOR UPDATE`,
        [id, session.tenantId, scope.userId]
      );
      if (!current.rows[0]) return "missing" as const;
      await client.query(
        `UPDATE conversations
         SET ai_active=true,handoff_reason=NULL,handoff_error_code=NULL,status='open',resolved_at=NULL,
             ai_commercial_override_at=now()
         WHERE id=$1 AND tenant_id=$2`,
        [id, session.tenantId]
      );
      return "reactivated" as const;
    });
    if (reactivated === "missing") return reply.status(404).send({ error: "Conversa não encontrada" });
    return { ok: true };
  });
  app.post("/conversations/:id/reply-with-ai", async (request, reply) => {
    const session = await requirePermission(request, "conversations.reactivate");
    const { id } = idParams.parse(request.params);
    const scope = await resolveCaseScope(db, session);
    const recovery = await withTenantTransaction(db, session.tenantId, async (client) => {
      const conversation = await client.query<{
        session_id: string | null;
        contact_phone: string;
        contact_jid: string | null;
        contact_name: string | null;
        channel: "whatsapp" | "instagram";
        agent_is_active: boolean;
      }>(
        `SELECT conversation.session_id,conversation.contact_phone,conversation.contact_jid,
                conversation.contact_name,ws.channel,COALESCE(agent.is_active,false) agent_is_active
         FROM conversations conversation
         LEFT JOIN whatsapp_sessions ws ON ws.id=conversation.session_id AND ws.tenant_id=conversation.tenant_id
         LEFT JOIN LATERAL (
           SELECT config.is_active FROM agent_configs config
           WHERE config.tenant_id=conversation.tenant_id
             AND (config.session_id=conversation.session_id OR config.session_id IS NULL)
           ORDER BY (config.session_id IS NOT NULL) DESC,config.updated_at DESC,config.id
           LIMIT 1
         ) agent ON true
         WHERE conversation.id=$1 AND conversation.tenant_id=$2
           AND (${conversationScopeCondition(scope, "conversation", "$3")})
         FOR UPDATE OF conversation`,
        [id, session.tenantId, scope.userId]
      );
      const current = conversation.rows[0];
      if (!current) return { status: "missing" as const };
      if (current.channel === "instagram") return { status: "instagram_channel" as const };
      if (!current.session_id) return { status: "no_session" as const };
      if (!current.agent_is_active) return { status: "agent_inactive" as const };
      const latest = await client.query<{
        id: string;
        sender: "contact" | "agent" | "human";
        content: string;
        external_message_id: string | null;
        media_type: "audio" | "image" | "document" | null;
        media_mime_type: string | null;
        media_file_name: string | null;
        media_size_bytes: number | null;
        media_is_sticker: boolean;
        processed_at: Date | null;
        processing_started_at: Date | null;
      }>(
        `SELECT id,sender,content,external_message_id,media_type,media_mime_type,
                media_file_name,media_size_bytes,media_is_sticker,processed_at,processing_started_at
         FROM messages
         WHERE conversation_id=$1
         ORDER BY created_at DESC,id DESC
         LIMIT 1
         FOR UPDATE`,
        [id]
      );
      const message = latest.rows[0];
      if (!message || message.sender !== "contact") return { status: "already_answered" as const };
      if (!message.external_message_id) return { status: "missing_external_id" as const };
      if (
        message.processed_at === null
        && message.processing_started_at
        && Date.now() - message.processing_started_at.getTime() < 10 * 60_000
      ) return { status: "processing" as const };

      await client.query(
        `UPDATE conversations
         SET ai_active=true,handoff_reason=NULL,handoff_error_code=NULL,status='open',resolved_at=NULL,
             ai_commercial_override_at=now()
         WHERE id=$1 AND tenant_id=$2`,
        [id, session.tenantId]
      );
      const resumed = await client.query<{ lead_id: string }>(
        `UPDATE lead_qualifications qualification
         SET status='em_andamento',ask_pending=true,updated_at=now()
         FROM scheduling_leads lead
         WHERE lead.id=qualification.lead_id
           AND lead.tenant_id=qualification.tenant_id
           AND qualification.tenant_id=$1
           AND lead.phone=$2
           AND qualification.status='pausado'
         RETURNING qualification.lead_id`,
        [session.tenantId, current.contact_phone]
      );
      for (const lead of resumed.rows) {
        await client.query(
          `INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details)
           VALUES($1,$2,'formulario_retomado',$3)`,
          [lead.lead_id, session.tenantId, { origem: "resposta_manual_ia" }]
        );
      }
      await client.query(
        `UPDATE messages SET processed_at=NULL,processing_started_at=NULL
         WHERE id=$1 AND conversation_id=$2`,
        [message.id, id]
      );
      return {
        status: "ready" as const,
        message: {
          kind: "contact" as const,
          externalId: message.external_message_id,
          tenantId: session.tenantId,
          sessionId: current.session_id,
          contactPhone: current.contact_phone,
          ...(current.contact_jid ? { contactJid: current.contact_jid } : {}),
          ...(current.contact_name ? { contactName: current.contact_name } : {}),
          text: message.content,
          ...(message.media_type ? { mediaType: message.media_type } : {}),
          ...(message.media_mime_type ? { mediaMimeType: message.media_mime_type } : {}),
          ...(message.media_file_name ? { mediaFileName: message.media_file_name } : {}),
          ...(message.media_size_bytes !== null ? { mediaSizeBytes: message.media_size_bytes } : {}),
          ...(message.media_is_sticker ? { mediaIsSticker: true } : {})
        }
      };
    });

    if (recovery.status === "missing") return reply.status(404).send({ error: "Conversa não encontrada" });
    if (recovery.status === "instagram_channel") return reply.status(409).send({ error: "Esta conversa pertence ao canal Instagram e não pode ser enviada pelo WhatsApp" });
    if (recovery.status === "no_session") return reply.status(409).send({ error: "A conversa não possui uma conexão do WhatsApp" });
    if (recovery.status === "agent_inactive") return reply.status(409).send({ error: "Ative o agente de IA antes de solicitar uma resposta" });
    if (recovery.status === "already_answered") return reply.status(409).send({ error: "A última mensagem desta conversa não é do contato ou já recebeu resposta" });
    if (recovery.status === "missing_external_id") return reply.status(409).send({ error: "A última mensagem do contato não pode ser reenfileirada" });
    if (recovery.status === "processing") return reply.status(409).send({ error: "A IA já está processando esta mensagem. Aguarde alguns instantes" });

    try {
      await enqueueInboundRecovery(recovery.message);
    } catch (error) {
      app.log.error({ err: error, conversationId: id }, "Could not enqueue manual AI conversation recovery");
      return reply.status(503).send({ error: "Não foi possível colocar a resposta da IA na fila. Tente novamente" });
    }
    await auditLog({
      actorUserId: session.userId,
      workspaceId: session.tenantId,
      actorScope: session.actorScope,
      action: "conversation.ai_reply_requested",
      resourceType: "conversation",
      resourceId: id,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    return reply.status(202).send({ ok: true, queued: true });
  });
  app.patch("/conversations/:id/pause", async (request, reply) => {
    const session = await requirePermission(request, "conversations.reactivate"); const { id } = idParams.parse(request.params);
    const scope = await resolveCaseScope(db, session);
    const found = await withTenantTransaction(db, session.tenantId, async (client) => {
      const conversation = await client.query<{ contact_phone: string }>(
        `UPDATE conversations conversation
         SET ai_active=false,handoff_reason='manually_paused',handoff_error_code=NULL
         WHERE conversation.id=$1 AND conversation.tenant_id=$2
           AND (${conversationScopeCondition(scope, "conversation", "$3")})
         RETURNING contact_phone`,
        [id, session.tenantId, scope.userId]
      );
      if (!conversation.rows[0]) return false;
      const paused = await client.query<{ lead_id: string }>(
        `UPDATE lead_qualifications qualification
         SET status='pausado',updated_at=now()
         FROM scheduling_leads lead
         WHERE lead.id=qualification.lead_id
           AND lead.tenant_id=qualification.tenant_id
           AND qualification.tenant_id=$1
           AND lead.phone=$2
           AND qualification.status='em_andamento'
         RETURNING qualification.lead_id`,
        [session.tenantId, conversation.rows[0].contact_phone]
      );
      for (const lead of paused.rows) {
        await client.query(
          `INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details)
           VALUES($1,$2,'formulario_pausado',$3)`,
          [lead.lead_id, session.tenantId, { motivo: "manually_paused" }]
        );
      }
      return true;
    });
    if (!found) return reply.status(404).send({ error: "Conversa não encontrada" });
    await auditLog({
      actorUserId: session.userId,
      workspaceId: session.tenantId,
      actorScope: session.actorScope,
      action: "conversation.ai_paused",
      resourceType: "conversation",
      resourceId: id,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    return { ok: true };
  });
  app.patch("/conversations/:id/claim", async (request, reply) => {
    const session = await requirePermission(request, "conversations.reply");
    const { id } = idParams.parse(request.params);
    if (!await canAccessConversation(db, session, id)) {
      return reply.status(404).send({ error: "Conversa não encontrada" });
    }
    const actorMember = await db.query<{ member_id: string }>(
      `SELECT m.id member_id
       FROM scheduling_google_meet_closers pool
       JOIN workspace_members m
         ON m.id=pool.member_id AND m.workspace_id=pool.tenant_id AND m.status='active'
       JOIN users u ON u.id=m.user_id AND u.status='active'
       WHERE pool.tenant_id=$1 AND m.user_id=$2
         AND EXISTS (
           SELECT 1 FROM workspace_role_permissions permission
           WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.read'
         )
         AND EXISTS (
           SELECT 1 FROM workspace_role_permissions permission
           WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.reply'
         )
       LIMIT 1`,
      [session.tenantId, session.userId]
    );
    if (!actorMember.rows[0]) {
      return reply.status(400).send({ error: "Somente atendentes ativos do pool podem assumir conversas" });
    }
    const claim = await withTenantTransaction(db, session.tenantId, (client) =>
      transferCaseAssignment(client, {
        tenantId: session.tenantId,
        selector: { conversationId: id },
        targetMemberId: actorMember.rows[0].member_id,
        actor: {
          userId: session.userId,
          actorScope: session.actorScope,
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"]
        },
        manager: hasWorkspaceCaseAccess(session)
      })
    );
    if (!claim.found) return reply.status(404).send({ error: "Conversa não encontrada" });
    await auditLog({
      actorUserId: session.userId,
      workspaceId: session.tenantId,
      actorScope: session.actorScope,
      action: "conversation.claimed",
      resourceType: "conversation",
      resourceId: id,
      metadata: { fromUserId: claim.previousUserId, toUserId: session.userId },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    await refreshAppointmentGroupNotificationsForConversation(session.tenantId, id).catch((error) => {
      request.log.warn({ err: error, conversationId: id }, "Could not refresh appointment group notification after assignment");
    });
    return { ok: true };
  });
  app.patch("/conversations/:id/assign", async (request, reply) => {
    const session = await requirePermission(request, "conversations.reply");
    const { id } = idParams.parse(request.params);
    if (!await canAccessConversation(db, session, id)) {
      return reply.status(404).send({ error: "Conversa não encontrada" });
    }
    const { userId } = conversationAssignmentSchema.parse(request.body);
    const target = userId
      ? await db.query<{ member_id: string }>(
          `SELECT m.id member_id
           FROM scheduling_google_meet_closers pool
           JOIN workspace_members m
             ON m.id=pool.member_id AND m.workspace_id=pool.tenant_id AND m.status='active'
           JOIN users u ON u.id=m.user_id AND u.status='active'
           WHERE pool.tenant_id=$1 AND m.user_id=$2
             AND EXISTS (
               SELECT 1 FROM workspace_role_permissions permission
               WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.read'
             )
             AND EXISTS (
               SELECT 1 FROM workspace_role_permissions permission
               WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.reply'
             )
           LIMIT 1`,
          [session.tenantId, userId]
        )
      : null;
    if (userId && !target?.rows[0]) {
      return reply.status(400).send({ error: "Responsável deve ser um atendente ativo do pool" });
    }
    const assignment = await withTenantTransaction(db, session.tenantId, (client) =>
      transferCaseAssignment(client, {
        tenantId: session.tenantId,
        selector: { conversationId: id },
        targetMemberId: target?.rows[0]?.member_id ?? null,
        actor: {
          userId: session.userId,
          actorScope: session.actorScope,
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"]
        },
        manager: hasWorkspaceCaseAccess(session)
      })
    );
    if (!assignment.found) return reply.status(404).send({ error: "Conversa não encontrada" });
    await auditLog({
      actorUserId: session.userId,
      workspaceId: session.tenantId,
      actorScope: session.actorScope,
      action: userId ? "conversation.assigned" : "conversation.unassigned",
      resourceType: "conversation",
      resourceId: id,
      metadata: { fromUserId: assignment.previousUserId, toUserId: assignment.assignment?.userId ?? null },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    await refreshAppointmentGroupNotificationsForConversation(session.tenantId, id).catch((error) => {
      request.log.warn({ err: error, conversationId: id }, "Could not refresh appointment group notification after assignment");
    });
    return { ok: true };
  });
  app.patch("/conversations/:id/resolve", async (request, reply) => {
    const session = await requirePermission(request, "conversations.reply");
    const { id } = idParams.parse(request.params);
    const scope = await resolveCaseScope(db, session);
    const resolved = await withTenantTransaction(db, session.tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE conversations conversation
         SET status='closed', resolved_at=now(),
           claimed_at=CASE
             WHEN assigned_user_id IS NULL THEN NULL
             ELSE COALESCE(claimed_at,now())
           END
         WHERE conversation.id=$1 AND conversation.tenant_id=$2
           AND (${conversationScopeCondition(scope, "conversation", "$3")})
         RETURNING id`,
        [id, session.tenantId, scope.userId]
      );
      if (!updated.rows[0]) return { found: false, event: null };
      return { found: true };
    });
    if (!resolved.found) return reply.status(404).send({ error: "Conversa não encontrada" });
    await auditLog({
      actorUserId: session.userId,
      workspaceId: session.tenantId,
      actorScope: session.actorScope,
      action: "conversation.resolved",
      resourceType: "conversation",
      resourceId: id,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    return { ok: true };
  });
  app.patch("/conversations/:id/reopen", async (request, reply) => {
    const session = await requirePermission(request, "conversations.reply");
    const { id } = idParams.parse(request.params);
    const scope = await resolveCaseScope(db, session);
    const reopened = await withTenantTransaction(db, session.tenantId, async (client) => client.query(
      `UPDATE conversations conversation
       SET status='open',resolved_at=NULL
       WHERE conversation.id=$1 AND conversation.tenant_id=$2
         AND (${conversationScopeCondition(scope, "conversation", "$3")})
       RETURNING id`,
      [id, session.tenantId, scope.userId]
    ));
    if (!reopened.rows[0]) return reply.status(404).send({ error: "Conversa não encontrada" });
    await auditLog({
      actorUserId: session.userId,
      workspaceId: session.tenantId,
      actorScope: session.actorScope,
      action: "conversation.reopened",
      resourceType: "conversation",
      resourceId: id,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    return { ok: true };
  });
  app.post("/conversations/:id/follow-up", async (request, reply) => {
    const session = await requirePermission(request, "conversations.reply");
    const { id } = idParams.parse(request.params);
    const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
    const fingerprint = payloadFingerprint({ conversationId: id });
    const scope = await resolveCaseScope(db, session);
    const conversation = await db.query<{ session_id: string; contact_phone: string; contact_jid: string | null; channel: "whatsapp" | "instagram" | null; status: string }>(
      `SELECT c.session_id,c.contact_phone,c.contact_jid,ws.channel,c.status FROM conversations c
       LEFT JOIN whatsapp_sessions ws ON ws.id=c.session_id AND ws.tenant_id=c.tenant_id
       WHERE c.id=$1 AND c.tenant_id=$2 AND (${conversationScopeCondition(scope, "c", "$3")})`,
      [id, session.tenantId, scope.userId]
    );
    if (!conversation.rows[0]) return reply.status(404).send({ error: "Conversa não encontrada" });
    const channelError = whatsappChannelError(conversation.rows[0].channel);
    if (channelError) return reply.status(409).send({ error: channelError });
    if (conversation.rows[0].status !== "open") return reply.status(409).send({ error: "Reabra a conversa antes de fazer follow-up" });
    const row = conversation.rows[0];
    const processor = new AiFollowUpProcessor(new AiFollowUpRepository(db, config), whatsapp, new OpenRouterClient(config));
    let claimedResult: { requestId: string; duplicate: boolean; status: string; result?: { externalId: string; messageId: string | null } };
    try {
      claimedResult = await enqueueFollowUpOnce(db, { tenantId: session.tenantId, conversationId: id, idempotencyKey }, async () => {
        const outcome = await processor.process(id);
        if (outcome === "cancelled" || outcome === "not_due") throw Object.assign(new Error("not_needed"), { statusCode: 409 });
        if (outcome !== "sent") throw Object.assign(new Error("conversation_busy"), { statusCode: 409 });
        const sent = await db.query<{ id: string; external_message_id: string }>(`SELECT id,external_message_id FROM messages WHERE tenant_id=$2 AND conversation_id=$1 AND sender='agent' AND external_message_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [id, session.tenantId]);
        const updated = await withTenantTransaction(db, session.tenantId, async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`follow-up:${session.tenantId}:${id}`]);
          const lead = (await client.query<{ id: string }>(`SELECT id FROM scheduling_leads WHERE tenant_id=$1 AND regexp_replace(phone,'\\\\D','','g')=regexp_replace($2,'\\\\D','','g') FOR UPDATE`, [session.tenantId, row.contact_phone])).rows[0];
          if (!lead) return null;
          const stageId = await defaultStageId(client, session.tenantId, "follow_up");
          await client.query(`UPDATE scheduling_leads SET status='follow_up',pipeline_stage_id=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2`, [session.tenantId, lead.id, stageId]);
          return { leadId: lead.id, stageId };
        });
        if (!updated) throw new Error("stage_failed");
        return { externalId: sent.rows[0]?.external_message_id ?? "", messageId: sent.rows[0]?.id ?? null };
      });
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 409) return reply.status(409).send({ ok: false, code: "idempotency_conflict" });
      request.log.error({ err: error, conversationId: id, idempotencyKey, fingerprint }, "Manual follow-up enqueue failed");
      return reply.status(503).send({ ok: false, code: "follow_up_unavailable" });
    }
    return reply.status(202).send({ ok: true, status: claimedResult.status, request_id: claimedResult.requestId });
  });

  app.post("/conversations/:id/messages", {
    bodyLimit: 46 * 1024 * 1024,
    config: { rateLimit: HTTP_RATE_LIMITS.upload }
  }, async (request, reply) => {
    const session = await requirePermission(request, "conversations.reply"); const { id } = idParams.parse(request.params); const body = messageSchema.parse(request.body);
    const scope = await resolveCaseScope(db, session);
    const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
    const result = await db.query<{ session_id: string; contact_phone: string; contact_jid: string | null; channel: "whatsapp" | "instagram"; ai_active: boolean; status: string }>(
      `SELECT conversation.session_id,conversation.contact_phone,conversation.contact_jid,
              ws.channel,conversation.ai_active,conversation.status
       FROM conversations conversation
       LEFT JOIN whatsapp_sessions ws ON ws.id=conversation.session_id AND ws.tenant_id=conversation.tenant_id
       WHERE conversation.id=$1 AND conversation.tenant_id=$2
         AND (${conversationScopeCondition(scope, "conversation", "$3")})`,
      [id, session.tenantId, scope.userId]
    );
    if (!result.rows[0]) return reply.status(404).send({ error: "Conversa não encontrada" });
    const row = result.rows[0];
    if (row.channel === "instagram") return reply.status(409).send({ error: "Esta conversa pertence ao canal Instagram e não pode ser enviada pelo WhatsApp" });
    if (row.status !== "open") return reply.status(409).send({ error: "Reabra a conversa antes de responder" });
    if (row.ai_active) return reply.status(409).send({ error: "Pause a IA desta conversa antes de responder manualmente" });
    const repository = new MessageRepository(db);
    const mediaBody = "mediaType" in body ? body : undefined;
    const textBody = "text" in body ? body : undefined;
    const media = mediaBody ? decodeOutboundMedia(mediaBody) : undefined;
    if (media?.mediaType === "audio" && mediaBody?.caption?.trim()) {
      return reply.status(400).send({ error: "Mensagens de áudio não aceitam legenda" });
    }
    const text = media ? mediaBody?.caption?.trim() || media.fileName : textBody!.text;
    let quoted: { key: { id: string; remoteJid: string; fromMe: boolean }; text: string } | undefined;
    if (body.replyToMessageId) {
      const quotedRow = await db.query<{ sender: "contact" | "agent" | "human"; content: string; external_message_id: string | null }>(
        "SELECT sender, content, external_message_id FROM messages WHERE id=$1 AND conversation_id=$2",
        [body.replyToMessageId, id]
      );
      if (!quotedRow.rows[0]) return reply.status(404).send({ error: "Mensagem citada não encontrada" });
      const quotedMessage = quotedRow.rows[0];
      if (!quotedMessage.external_message_id) return reply.status(409).send({ error: "Mensagem citada ainda não foi confirmada pelo WhatsApp" });
      if (!row.contact_jid) return reply.status(409).send({ error: "Conversa sem identificador do WhatsApp para responder citando" });
      quoted = {
        key: { id: quotedMessage.external_message_id, remoteJid: row.contact_jid, fromMe: quotedMessage.sender !== "contact" },
        text: quotedMessage.content.slice(0, 200)
      };
    }
    const signature = await resolveSignatureSettings(db, session.tenantId, id);
    const signatureName = signature
      ? (await db.query<{ name: string | null; email: string }>("SELECT name,email FROM users WHERE id=$1", [session.userId])).rows[0]
      : null;
    const senderName = signatureName ? signatureName.name ?? signatureName.email : null;
    const outboundText = signature && senderName && !media ? applySignature(textBody!.text, senderName, signature) : textBody?.text;
    const outboundCaption = signature && senderName && mediaBody?.caption?.trim()
      ? applySignature(mediaBody.caption.trim(), senderName, signature)
      : mediaBody?.caption?.trim();
    await new QualificationService().pauseForConversation(session.tenantId, id, "manually_paused");
    const sent = await repository.sendManualMessageOnce({
      tenantId: session.tenantId,
      conversationId: id,
      sessionId: row.session_id,
      contactPhone: row.contact_phone,
      contactJid: row.contact_jid ?? undefined,
      text,
      ...(!media ? { sendText: outboundText ?? text } : {}),
      idempotencyKey,
      sentByUserId: session.userId,
      ...(body.replyToMessageId ? { replyToMessageId: body.replyToMessageId } : {}),
      ...(media ? {
        mediaType: media.mediaType,
        mediaMimeType: media.mimeType,
        mediaFileName: media.fileName,
        mediaSizeBytes: media.sizeBytes,
        contentFingerprint: media.contentFingerprint
      } : {})
    }, () => media
      ? whatsapp.sendMedia(row.session_id, row.contact_jid ?? row.contact_phone, {
        mediaType: media.mediaType,
        mimeType: media.mimeType,
        fileName: media.fileName,
        dataBase64: media.dataBase64,
        ...(outboundCaption ? { caption: outboundCaption } : {})
      })
      // ponytail: media replies don't carry WA quoting yet, sendMedia has no quoted param
      : whatsapp.sendText(
        row.session_id,
        row.contact_jid ?? row.contact_phone,
        outboundText!,
        quoted
      ));
    return reply.status(sent.duplicate ? 200 : 201).send({ sent: true, externalId: sent.externalId, duplicate: sent.duplicate });
  });

  async function loadOwnConversationMessage(
    session: Awaited<ReturnType<typeof requirePermission>>,
    conversationId: string,
    messageId: string
  ) {
    const scope = await resolveCaseScope(db, session);
    const result = await db.query<{
      session_id: string; contact_phone: string; contact_jid: string | null; channel: "whatsapp" | "instagram" | null;
      sender: "contact" | "agent" | "human"; external_message_id: string | null; media_type: string | null;
      deleted_at: Date | null; deleted_for_everyone_at: Date | null;
    }>(
      `SELECT c.session_id, c.contact_phone, c.contact_jid, ws.channel,
              m.sender, m.external_message_id, m.media_type, m.deleted_at, m.deleted_for_everyone_at
       FROM conversations c JOIN messages m ON m.conversation_id=c.id
       LEFT JOIN whatsapp_sessions ws ON ws.id=c.session_id AND ws.tenant_id=c.tenant_id
       WHERE c.id=$1 AND m.id=$2 AND c.tenant_id=$3
         AND (${conversationScopeCondition(scope, "c", "$4")})`,
      [conversationId, messageId, session.tenantId, scope.userId]
    );
    return result.rows[0];
  }

  app.post("/conversations/:id/messages/:messageId/react", async (request, reply) => {
    const session = await requirePermission(request, "conversations.reply");
    const { id, messageId } = messageIdParams.parse(request.params);
    const { emoji } = messageReactionSchema.parse(request.body);
    const message = await loadOwnConversationMessage(session, id, messageId);
    if (!message) return reply.status(404).send({ error: "Mensagem não encontrada" });
    const channelError = whatsappChannelError(message.channel);
    if (channelError) return reply.status(409).send({ error: channelError });
    if (!message.external_message_id || !message.contact_jid) {
      return reply.status(409).send({ error: "Mensagem ainda não confirmada pelo WhatsApp" });
    }
    await whatsapp.sendReactionStrict(message.session_id, message.contact_jid, {
      id: message.external_message_id, remoteJid: message.contact_jid, fromMe: message.sender !== "contact"
    }, emoji ?? "");
    const updated = await db.query<{ reaction_emoji: string | null }>(
      "UPDATE messages SET reaction_emoji=$1 WHERE id=$2 RETURNING reaction_emoji",
      [emoji, messageId]
    );
    return { ok: true, reaction_emoji: updated.rows[0]?.reaction_emoji ?? null };
  });

  app.patch("/conversations/:id/messages/:messageId", async (request, reply) => {
    const session = await requirePermission(request, "conversations.reply");
    const { id, messageId } = messageIdParams.parse(request.params);
    const { text } = messageEditSchema.parse(request.body);
    const message = await loadOwnConversationMessage(session, id, messageId);
    if (!message) return reply.status(404).send({ error: "Mensagem não encontrada" });
    const channelError = whatsappChannelError(message.channel);
    if (channelError) return reply.status(409).send({ error: channelError });
    if (message.sender !== "human") return reply.status(409).send({ error: "Só é possível editar mensagens enviadas por você" });
    if (message.media_type) return reply.status(409).send({ error: "Não é possível editar mensagens de mídia" });
    if (message.deleted_at) return reply.status(409).send({ error: "Mensagem apagada não pode ser editada" });
    if (!message.external_message_id || !message.contact_jid) {
      return reply.status(409).send({ error: "Mensagem ainda não confirmada pelo WhatsApp" });
    }
    await whatsapp.updateText(message.session_id, message.contact_jid, message.external_message_id, text);
    const updated = await db.query<{ content: string; edited_at: Date }>(
      "UPDATE messages SET content=$1,edited_at=now() WHERE id=$2 RETURNING content,edited_at",
      [text, messageId]
    );
    await auditLog({
      actorUserId: session.userId, workspaceId: session.tenantId, actorScope: session.actorScope,
      action: "message.edited", resourceType: "message", resourceId: messageId,
      ipAddress: request.ip, userAgent: request.headers["user-agent"]
    });
    return { ok: true, content: updated.rows[0]?.content, edited_at: updated.rows[0]?.edited_at };
  });

  app.delete("/conversations/:id/messages/:messageId", async (request, reply) => {
    const session = await requirePermission(request, "conversations.reply");
    const { id, messageId } = messageIdParams.parse(request.params);
    const { forEveryone } = messageDeleteSchema.parse(request.body ?? {});
    const message = await loadOwnConversationMessage(session, id, messageId);
    if (!message) return reply.status(404).send({ error: "Mensagem não encontrada" });
    if (message.deleted_at) return { ok: true };
    if (forEveryone) {
      const channelError = whatsappChannelError(message.channel);
      if (channelError) return reply.status(409).send({ error: channelError });
      if (message.sender !== "human") return reply.status(409).send({ error: "Só é possível apagar para todos suas próprias mensagens" });
      if (!message.external_message_id || !message.contact_jid) {
        return reply.status(409).send({ error: "Mensagem ainda não confirmada pelo WhatsApp" });
      }
      await whatsapp.deleteMessageForEveryone(message.session_id, message.contact_jid, {
        id: message.external_message_id, remoteJid: message.contact_jid, fromMe: true
      });
      await db.query("UPDATE messages SET deleted_at=now(),deleted_for_everyone_at=now() WHERE id=$1", [messageId]);
      await auditLog({
        actorUserId: session.userId, workspaceId: session.tenantId, actorScope: session.actorScope,
        action: "message.deleted_for_everyone", resourceType: "message", resourceId: messageId,
        ipAddress: request.ip, userAgent: request.headers["user-agent"]
      });
    } else {
      await db.query("UPDATE messages SET deleted_at=now() WHERE id=$1", [messageId]);
    }
    return { ok: true };
  });

  void app.register(registerWorkspaceRoutes);
  void app.register(registerRootRoutes);
  void app.register(registerSaasRoutes);
  void app.register(registerBillingRoutes, options.billingOAuth ?? {});
  void app.register(registerOperationsRoutes);
  void app.register(registerWhatsAppConnectionRoutes, { whatsapp });
  void app.register(registerDashboardWidgetRoutes);
  void app.register(registerOrganizationRoutes);
  void app.register(registerPostSalesRoutes);
  void app.register(registerSchedulingRoutes);
  void app.register(registerMeetRoutes);
  void app.register(registerStickerRoutes);
  void app.register(registerQualificationRoutes);
  void app.register(registerWebPushRoutes);
  void app.register(registerTripzAiRoutes, {
    repository: tripzRepository,
    onMessageCreated: async ({ scope, conversationId, message, attachmentIds }: TripzMessageCreatedContext) => {
      await enqueueTripzAiTurn({ scope, conversationId, messageId: message.id, attachmentIds });
    },
    renderPreview: async ({ scope, proposal }: TripzDocumentRenderContext) => tripzDocuments.renderPreview(scope, proposal),
    renderPdf: async ({ scope, proposal }: TripzDocumentRenderContext) => tripzDocuments.renderPdf(scope, proposal)
  });
  void app.register(registerConversationQueueRoutes);

  return app;
}
