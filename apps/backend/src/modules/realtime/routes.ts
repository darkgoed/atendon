import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyTypeProvider,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault
} from "fastify";
import { requireSession, type WorkspaceSession } from "../../auth/session.js";
import { config } from "../../config.js";
import type { RealtimeCoordinator } from "./coordinator.js";
import { resolveCaseScope } from "../../auth/case-scope.js";
import { db } from "../../db/client.js";
import { panelPresence } from "./presence.js";

type RealtimeAuthorization = Pick<
  WorkspaceSession,
  "actorScope" | "permissions" | "role" | "roleId" | "tenantId" | "userId"
>;

export function sameRealtimeAuthorization(
  original: RealtimeAuthorization,
  current: RealtimeAuthorization
): boolean {
  return current.tenantId === original.tenantId
    && current.userId === original.userId
    && current.actorScope === original.actorScope
    && current.role === original.role
    && current.roleId === original.roleId
    && [...current.permissions].sort().join("\u0000")
      === [...original.permissions].sort().join("\u0000");
}

export function registerRealtimeRoutes<
  AppLogger extends FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider
>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    AppLogger,
    TypeProvider
  >,
  coordinator: RealtimeCoordinator
): void {
  app.get("/events", async (request, reply) => {
    const origin = request.headers.origin;
    const fetchSite = request.headers["sec-fetch-site"];
    if ((origin && origin !== config.PANEL_ORIGIN) || fetchSite === "cross-site") {
      return reply.status(403).send({ error: "Origem não permitida" });
    }
    if (!String(request.headers.accept ?? "").includes("text/event-stream")) {
      return reply.status(406).send({ error: "Use Accept: text/event-stream" });
    }
    const session = await requireSession(request);
    const requestedTenantId = (request.query as { tenantId?: unknown }).tenantId;
    if (typeof requestedTenantId !== "string" || requestedTenantId !== session.tenantId) {
      return reply.status(403).send({ error: "Workspace do stream não corresponde à sessão" });
    }
    const caseScope = await resolveCaseScope(db, session);
    await coordinator.ensureStarted();

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive"
    });
    const remove = coordinator.hub.add({
      tenantId: session.tenantId,
      userId: session.userId,
      caseScope: caseScope.type,
      permissions: new Set(session.permissions),
      write: (chunk) => reply.raw.write(chunk),
      close: () => {
        if (!reply.raw.writableEnded) reply.raw.end();
      }
    }, typeof request.headers["last-event-id"] === "string"
      ? request.headers["last-event-id"].slice(0, 256)
      : undefined);
    if (!remove) {
      if (!reply.raw.writableEnded) reply.raw.end();
      return;
    }
    void panelPresence.touch(session.tenantId, session.userId);
    const presenceHeartbeat = setInterval(() => {
      void requireSession(request).then((current) => {
        if (!sameRealtimeAuthorization(session, current)) {
          cleanup();
          return;
        }
        return panelPresence.touch(session.tenantId, session.userId);
      }).catch(cleanup);
    }, 15_000);
    presenceHeartbeat.unref();
    let removed = false;
    const cleanup = () => {
      if (removed) return;
      removed = true;
      clearInterval(presenceHeartbeat);
      remove();
    };
    request.raw.once("close", cleanup);
  });
}
