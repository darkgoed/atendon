import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { requirePermission } from "../../auth/session.js";
import type { PermissionKey } from "../../auth/rbac.js";
import { InstagramOAuthStore, createOAuthState } from "./oauth.js";
import { verifyMediaUrl } from "./media.js";
import { verifyChallenge } from "./provider.js";
import { handleInstagramWebhook } from "./webhook.js";
import type { InstagramService } from "./service.js";

const oauthStartSchema = z.object({
  label: z.string().trim().min(1).max(60),
  connection_id: z.string().uuid().optional()
}).strict();
const callbackQuerySchema = z.object({
  code: z.string().min(1).max(4096),
  state: z.string().min(32).max(256)
});
const connectionParamsSchema = z.object({ id: z.string().uuid() });
const mediaQuerySchema = z.object({ signature: z.string().min(1).max(1024) });

export interface InstagramRouteSession {
  tenantId: string;
  userId: string;
  sessionVersion?: number;
  permissions: readonly string[];
}

export type InstagramRouteAuthorizer = (
  request: FastifyRequest,
  permission: Extract<PermissionKey, "connection.read" | "connection.manage">
) => Promise<InstagramRouteSession>;

export interface InstagramRouteOptions {
  service: InstagramService;
  oauth: InstagramOAuthStore;
  configured?: boolean;
  appId?: string;
  appSecret?: string;
  redirectUri?: string;
  verifyToken?: string;
  panelPublicUrl?: string;
  graphVersion?: string;
  maxConnections?: number;
  mediaSigningSecret: string;
  authorize?: InstagramRouteAuthorizer;
}

function callbackLocation(panelPublicUrl: string, outcome: "connected" | "error", reasonCode?: string): string {
  const destination = new URL("/conexao", panelPublicUrl);
  destination.searchParams.set("instagram", outcome);
  if (reasonCode) destination.searchParams.set("instagram_reason", reasonCode);
  return destination.toString();
}

function requiredSessionVersion(session: InstagramRouteSession): number {
  if (!Number.isInteger(session.sessionVersion) || Number(session.sessionVersion) < 1) {
    throw Object.assign(new Error("Sessão inválida"), { statusCode: 401 });
  }
  return Number(session.sessionVersion);
}

export async function registerInstagramRoutes(
  app: FastifyInstance,
  options: InstagramRouteOptions
): Promise<void> {
  const authorize: InstagramRouteAuthorizer = options.authorize
    ?? ((request, permission) => requirePermission(request, permission));
  const panelPublicUrl = options.panelPublicUrl ?? config.PANEL_PUBLIC_URL;
  const graphVersion = options.graphVersion ?? config.INSTAGRAM_GRAPH_VERSION;
  const maxConnections = options.maxConnections ?? config.INSTAGRAM_MAX_CONNECTIONS;
  const missing = [
    !options.appId ? "INSTAGRAM_APP_ID" : null,
    !options.appSecret ? "INSTAGRAM_APP_SECRET" : null,
    !options.verifyToken ? "INSTAGRAM_WEBHOOK_VERIFY_TOKEN" : null,
    !options.redirectUri ? "INSTAGRAM_REDIRECT_URI" : null
  ].filter((name): name is string => name !== null);
  const configured = (options.configured ?? true) && missing.length === 0;

  app.get("/instagram/status", async (request) => {
    await authorize(request, "connection.read");
    return {
      configured,
      missing,
      graph_version: graphVersion,
      max_connections: maxConnections
    };
  });

  app.post("/instagram/oauth/start", async (request, reply) => {
    const session = await authorize(request, "connection.manage");
    if (!configured || !options.appId || !options.redirectUri) {
      throw Object.assign(new Error("Instagram não configurado"), { statusCode: 503 });
    }
    const body = oauthStartSchema.parse(request.body);
    const state = createOAuthState();
    await options.oauth.create({
      tenantId: session.tenantId,
      userId: session.userId,
      sessionVersion: requiredSessionVersion(session),
      state: state.state,
      browserNonce: state.browserNonce,
      redirectUri: options.redirectUri,
      label: body.label,
      connectionId: body.connection_id,
      forceReauth: body.connection_id !== undefined
    });
    const authorizationUrl = new URL("https://www.instagram.com/oauth/authorize");
    authorizationUrl.search = new URLSearchParams({
      client_id: options.appId,
      redirect_uri: options.redirectUri,
      response_type: "code",
      scope: "instagram_business_basic,instagram_business_manage_messages",
      state: state.state,
      enable_fb_login: "false",
      ...(body.connection_id ? { force_reauth: "true" } : {})
    }).toString();
    reply.setCookie("instagram_oauth_nonce", state.browserNonce, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.NODE_ENV === "production",
      path: "/",
      maxAge: 600
    });
    return { authorization_url: authorizationUrl.toString() };
  });

  app.get("/instagram/oauth/callback", async (request, reply) => {
    const location = (outcome: "connected" | "error", reasonCode?: string) =>
      callbackLocation(panelPublicUrl, outcome, reasonCode);
    try {
      if (!configured || !options.redirectUri) throw new Error("Instagram is not configured");
      const session = await authorize(request, "connection.manage");
      const query = callbackQuerySchema.parse(request.query);
      const browserNonce = request.cookies.instagram_oauth_nonce;
      if (!browserNonce) throw new Error("OAuth nonce missing");
      const state = await options.oauth.consume({
        tenantId: session.tenantId,
        userId: session.userId,
        sessionVersion: requiredSessionVersion(session),
        state: query.state,
        browserNonce,
        redirectUri: options.redirectUri
      });
      await options.service.connectOAuth({
        tenantId: session.tenantId,
        label: state.label,
        connectionId: state.connectionId,
        code: query.code,
        redirectUri: options.redirectUri
      });
      reply.clearCookie("instagram_oauth_nonce", { path: "/" });
      return reply.redirect(location("connected"));
    } catch (error) {
      request.log.error(
        { err: error, context: "instagram_oauth_callback" },
        "Instagram OAuth callback failed"
      );
      reply.clearCookie("instagram_oauth_nonce", { path: "/" });
      // A mensagem genérica escondia o motivo real de falhas legítimas e
      // recorrentes (ex.: conta do Instagram já conectada em outro tenant,
      // ou faltando o escopo instagram_business_manage_messages) atrás de
      // "verifique as permissões", levando o usuário a tentar reautorizar
      // repetidamente sem nunca resolver. O painel usa este código para
      // mostrar a causa específica.
      const reasonCode = typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code
        : undefined;
      return reply.redirect(location("error", reasonCode));
    }
  });

  app.get("/webhooks/instagram", async (request, reply) => {
    if (!options.verifyToken) return reply.code(503).send("unavailable");
    const query = request.query as Record<string, unknown>;
    try {
      const challenge = verifyChallenge({
        mode: typeof query["hub.mode"] === "string" ? query["hub.mode"] : undefined,
        token: typeof query["hub.verify_token"] === "string" ? query["hub.verify_token"] : undefined,
        challenge: typeof query["hub.challenge"] === "string" ? query["hub.challenge"] : undefined
      }, options.verifyToken);
      return reply.type("text/plain").send(challenge);
    } catch {
      return reply.code(403).send("forbidden");
    }
  });

  await app.register(async (webhookScope) => {
    webhookScope.removeContentTypeParser("application/json");
    webhookScope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body)
    );
    webhookScope.post("/webhooks/instagram", async (request, reply) => {
      if (!options.appSecret) return reply.code(503).send({ error: "instagram unavailable" });
      if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: "invalid payload" });
      return handleInstagramWebhook(request, reply, {
        repository: options.service.repository,
        appSecret: options.appSecret,
        resolveAccount: (accountId) => options.service.repository.resolveAccount(accountId),
        rawBody: request.body
      });
    });
  });

  app.post("/instagram/connections/:id/refresh", async (request) => {
    const session = await authorize(request, "connection.manage");
    const params = connectionParamsSchema.parse(request.params);
    return options.service.refresh(session.tenantId, params.id);
  });

  app.post("/instagram/connections/:id/disconnect", async (request) => {
    const session = await authorize(request, "connection.manage");
    const params = connectionParamsSchema.parse(request.params);
    return options.service.disconnect(session.tenantId, params.id);
  });

  app.get("/instagram/media/:id", async (request, reply) => {
    const params = connectionParamsSchema.parse(request.params);
    const query = mediaQuerySchema.parse(request.query);
    if (!verifyMediaUrl(query.signature, params.id, options.mediaSigningSecret)) {
      return reply.code(403).send({ error: "invalid or expired media signature" });
    }
    const media = await options.service.repository.getPublicMedia(params.id);
    if (!media) return reply.code(404).send({ error: "media not found" });
    return reply
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .header("content-length", String(media.sizeBytes))
      .type(media.contentType)
      .send(media.bytes);
  });
}
