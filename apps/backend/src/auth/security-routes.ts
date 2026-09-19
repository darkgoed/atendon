import { compare } from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { httpError, withTransaction } from "../modules/scheduling/service.js";
import { HTTP_RATE_LIMITS } from "../security/http-rate-limit.js";
import { listWorkspacesForUser } from "./workspace-service.js";
import {
  createSessionToken,
  requireWorkspace
} from "./session.js";
import {
  createWorkspaceSessionRow,
  insertSecurityAudit,
  listWorkspaceSessions,
  revokeOtherSessions,
  revokeWorkspaceSession
} from "./sessions.js";
import {
  clearTotpChallenge,
  encryptTotpSecret,
  generateTotpSecret,
  loadTotpState,
  readTotpChallenge,
  totpAuthUrl,
  verifyTotp
} from "./totp.js";

/**
 * B2 Security (b) (specs/active/v7-port-crm-whatsapp.md, ONDA 2): rotas de
 * 2FA TOTP por usuário e sessões ativas revogáveis.
 *
 * - Setup NÃO ativa: só grava o segredo (cifrado); ativação exige código
 *   válido; desativação exige re-autenticação por senha (padrão 401
 *   "Senha atual inválida" do PATCH /me/profile).
 * - /auth/totp/verify é o 2º passo do login: consome o cookie de desafio
 *   (totp.ts), replica o picking de workspace do /auth/login
 *   (listWorkspacesForUser + home do ROOT), registra a linha em
 *   workspace_sessions e emite o cookie atendon_session com `sid`. O shape de
 *   resposta é o MESMO do login ({user, activeWorkspace, workspaces}).
 * - Sessões: lista/revoga linhas de workspace_sessions (0178); revogar a
 *   própria limpa o cookie; revoke-others revoga as outras linhas, sobe
 *   session_version (mata tokens legados sem sid) e REEMITE o cookie atual.
 * - Todo evento audita via insertSecurityAudit (totp.*, sessions.*).
 */

const totpCodeSchema = z.object({
  // verifyTotp normaliza (só dígitos, 6); aqui só limitamos tamanho bruto.
  code: z.string().trim().min(6).max(12)
}).strict();

const totpDeactivateSchema = z.object({
  current_password: z.string().min(1).max(200)
}).strict();

const sessionIdParams = z.object({
  id: z.string().uuid()
}).strict();

const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: config.NODE_ENV === "production",
  path: "/",
  maxAge: 43_200
};

export async function registerSecurityRoutes(app: FastifyInstance) {
  app.post("/me/totp/setup", { config: { rateLimit: HTTP_RATE_LIMITS.sensitiveWrite } }, async (request) => {
    const session = await requireWorkspace(request);
    const current = await loadTotpState(session.userId);
    if (current.enabled) {
      throw httpError(409, "Verificação em duas etapas já está ativa; desative antes de reconfigurar");
    }
    const secret = generateTotpSecret();
    await withTransaction(async (client) => {
      await client.query(
        "UPDATE users SET totp_secret_encrypted=$2,totp_enabled_at=NULL,updated_at=now() WHERE id=$1",
        [session.userId, encryptTotpSecret(secret)]
      );
      await insertSecurityAudit(client, {
        actorUserId: session.userId,
        workspaceId: session.tenantId,
        actorScope: session.actorScope,
        action: "totp.setup",
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
    });
    return { secret, otpauth_url: totpAuthUrl(secret, session.email) };
  });

  app.post("/me/totp/activate", { config: { rateLimit: HTTP_RATE_LIMITS.sensitiveWrite } }, async (request) => {
    const session = await requireWorkspace(request);
    const body = totpCodeSchema.parse(request.body);
    const state = await loadTotpState(session.userId);
    if (!state.secretBase32) {
      throw httpError(409, "Conclua a configuração do 2FA antes de ativar");
    }
    if (state.enabled) {
      throw httpError(409, "Verificação em duas etapas já está ativa");
    }
    if (!verifyTotp(state.secretBase32, body.code)) {
      throw Object.assign(new Error("Código inválido"), { statusCode: 400 });
    }
    await withTransaction(async (client) => {
      const activated = await client.query<{ id: string }>(
        "UPDATE users SET totp_enabled_at=now(),updated_at=now() WHERE id=$1 AND totp_secret_encrypted IS NOT NULL AND totp_enabled_at IS NULL RETURNING id",
        [session.userId]
      );
      if (!activated.rows[0]) {
        throw httpError(409, "Verificação em duas etapas já está ativa");
      }
      await insertSecurityAudit(client, {
        actorUserId: session.userId,
        workspaceId: session.tenantId,
        actorScope: session.actorScope,
        action: "totp.activate",
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
    });
    return { ok: true };
  });

  app.post("/me/totp/deactivate", { config: { rateLimit: HTTP_RATE_LIMITS.sensitiveWrite } }, async (request) => {
    const session = await requireWorkspace(request);
    const body = totpDeactivateSchema.parse(request.body);
    const current = await db.query<{ password_hash: string | null }>(
      "SELECT password_hash FROM users WHERE id=$1",
      [session.userId]
    );
    const user = current.rows[0];
    if (!user?.password_hash || !(await compare(body.current_password, user.password_hash))) {
      throw Object.assign(new Error("Senha atual inválida"), { statusCode: 401 });
    }
    const state = await loadTotpState(session.userId);
    if (!state.enabled) {
      throw httpError(409, "Verificação em duas etapas não está ativa");
    }
    await withTransaction(async (client) => {
      await client.query(
        "UPDATE users SET totp_secret_encrypted=NULL,totp_enabled_at=NULL,updated_at=now() WHERE id=$1",
        [session.userId]
      );
      await insertSecurityAudit(client, {
        actorUserId: session.userId,
        workspaceId: session.tenantId,
        actorScope: session.actorScope,
        action: "totp.deactivate",
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
    });
    return { ok: true };
  });

  app.post("/auth/totp/verify", { config: { rateLimit: HTTP_RATE_LIMITS.login } }, async (request, reply) => {
    const body = totpCodeSchema.parse(request.body);
    const userId = await readTotpChallenge(request);

    const userResult = await db.query<{
      id: string;
      email: string;
      is_root: boolean;
      status: string;
      must_change_password: boolean;
    }>(
      "SELECT id,email,is_root,status,must_change_password FROM users WHERE id=$1",
      [userId]
    );
    const user = userResult.rows[0];
    if (!user || user.status !== "active") {
      clearTotpChallenge(reply);
      throw httpError(401, "Desafio de duas etapas expirado; faça login novamente");
    }

    const state = await loadTotpState(userId);
    if (!state.enabled || !state.secretBase32) {
      clearTotpChallenge(reply);
      throw httpError(401, "Verificação em duas etapas não está ativa");
    }
    if (!verifyTotp(state.secretBase32, body.code)) {
      // Desafio continua válido dentro do TTL — o usuário pode tentar de novo.
      throw httpError(401, "Código inválido");
    }

    // Picking de workspace idêntico ao /auth/login.
    const workspaces = await listWorkspacesForUser(db, user.id, user.is_root);
    let activeWorkspace = workspaces[0];
    if (user.is_root) {
      const home = await db.query<{ workspace_id: string }>(
        "SELECT workspace_id FROM workspace_members WHERE user_id=$1 AND status='active' ORDER BY created_at LIMIT 1",
        [user.id]
      );
      activeWorkspace = workspaces.find((workspace) => workspace.id === home.rows[0]?.workspace_id) ?? activeWorkspace;
    }
    if (!activeWorkspace) {
      clearTotpChallenge(reply);
      return reply.status(403).send({ error: "Usuário sem workspace ativo" });
    }

    const sid = await createWorkspaceSessionRow({
      userId: user.id,
      tenantId: activeWorkspace.id,
      kind: "session",
      ip: request.ip,
      userAgent: request.headers["user-agent"]
    });
    const token = await createSessionToken({
      userId: user.id,
      tenantId: activeWorkspace.id,
      email: user.email,
      role: activeWorkspace.role,
      isRoot: user.is_root,
      rootWorkspaceAccess: user.is_root,
      sid
    });
    reply.setCookie("atendon_session", token, SESSION_COOKIE_OPTIONS);
    clearTotpChallenge(reply);

    await insertSecurityAudit(db, {
      actorUserId: user.id,
      workspaceId: activeWorkspace.id,
      actorScope: user.is_root ? "root" : "workspace",
      action: "totp.verify",
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });

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

  app.get("/me/sessions", async (request) => {
    const session = await requireWorkspace(request);
    return { items: await listWorkspaceSessions(session.userId, session.sid ?? null) };
  });

  app.delete("/me/sessions/:id", { config: { rateLimit: HTTP_RATE_LIMITS.sensitiveWrite } }, async (request, reply) => {
    const session = await requireWorkspace(request);
    const { id } = sessionIdParams.parse(request.params);
    const revoked = await revokeWorkspaceSession(session.userId, id);
    if (!revoked) throw httpError(404, "Sessão não encontrada");
    const own = id === session.sid;
    await insertSecurityAudit(db, {
      actorUserId: session.userId,
      workspaceId: session.tenantId,
      actorScope: session.actorScope,
      action: own ? "sessions.revoked_self" : "sessions.revoked",
      resourceId: id,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    if (own) reply.clearCookie("atendon_session", { path: "/" });
    return { ok: true, current: own };
  });

  app.post("/me/sessions/revoke-others", { config: { rateLimit: HTTP_RATE_LIMITS.sensitiveWrite } }, async (request, reply) => {
    const session = await requireWorkspace(request);
    const count = await revokeOtherSessions(session.userId, session.sid ?? "");
    // O bump invalida também tokens legados (sem sid) das outras sessões; a
    // reemissão abaixo mantém a sessão atual válida com o novo version.
    const updated = await db.query<{ session_version: number }>(
      "UPDATE users SET session_version=session_version+1,updated_at=now() WHERE id=$1 RETURNING session_version",
      [session.userId]
    );
    if (!updated.rows[0]) throw httpError(401, "Usuário desativado");
    const token = await createSessionToken({ ...session, sessionVersion: updated.rows[0].session_version });
    reply.setCookie("atendon_session", token, SESSION_COOKIE_OPTIONS);
    await insertSecurityAudit(db, {
      actorUserId: session.userId,
      workspaceId: session.tenantId,
      actorScope: session.actorScope,
      action: "sessions.revoked_others",
      resourceId: null,
      metadata: { count },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    return { ok: true, revoked: count };
  });
}
