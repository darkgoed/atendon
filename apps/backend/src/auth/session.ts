import { randomUUID } from "node:crypto";
import { SignJWT, errors, jwtVerify } from "jose";
import type { FastifyRequest } from "fastify";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { PERMISSIONS, type PermissionKey } from "./rbac.js";
import { isWorkspaceSessionRevoked } from "./sessions.js";

export interface PanelSession { userId: string; tenantId: string; email: string; role: string; isRoot?: boolean; sessionVersion?: number; rootWorkspaceAccess?: boolean; sid?: string }
export interface IdentitySession {
  userId: string;
  tenantId?: string;
  email: string;
  isRoot: boolean;
  sessionVersion?: number;
  rootWorkspaceAccess?: boolean;
  mustChangePassword?: boolean;
  // B2 Security: id da linha workspace_sessions (0178). Tokens sem sid são
  // legados (pré-migration) e seguem válidos até o TTL.
  sid?: string;
}
export interface WorkspaceSession extends IdentitySession {
  tenantId: string;
  role: string;
  roleId: string | null;
  permissions: PermissionKey[];
  actorScope: "root" | "workspace";
}

const secret = new TextEncoder().encode(config.JWT_SECRET);

export async function createSessionToken(session: PanelSession | IdentitySession): Promise<string> {
  const sessionVersion = session.sessionVersion ?? (await db.query<{ session_version: number }>(
    "SELECT session_version FROM users WHERE id=$1",
    [session.userId]
  )).rows[0]?.session_version;
  if (!sessionVersion) throw Object.assign(new Error("Usuário inválido"), { statusCode: 401 });
  return new SignJWT({ ...session, sessionVersion } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(secret);
}

export async function requireIdentity(
  request: FastifyRequest,
  options: { allowPasswordChangeRequired?: boolean } = {}
): Promise<IdentitySession> {
  const token = request.cookies.atendon_session;
  if (!token) throw Object.assign(new Error("Não autenticado"), { statusCode: 401 });
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    const userId = String(payload.userId);
    const current = await db.query<{ email: string; status: string; is_root: boolean; session_version: number; must_change_password: boolean }>(
      "SELECT email,status,is_root,session_version,must_change_password FROM users WHERE id=$1",
      [userId]
    );
    if (!current.rows[0] || current.rows[0].status !== "active") {
      throw Object.assign(new Error("Usuário desativado"), { statusCode: 401 });
    }
    // B2 Security: desafio TOTP não é sessão — só /auth/totp/verify o consome.
    // A rejeição vem ANTES do session_version: o desafio não carrega sessão.
    if (payload.totpChallenge === true) {
      throw Object.assign(new Error("Conclua a verificação em duas etapas"), { statusCode: 401 });
    }
    if (Number(payload.sessionVersion) !== current.rows[0].session_version) {
      throw Object.assign(new Error("Sessão revogada"), { statusCode: 401 });
    }
    // Sessões com sid consultam workspace_sessions (revogação individual).
    // Tokens legados (sem sid) continuam válidos até o TTL do JWT.
    if (typeof payload.sid === "string" && await isWorkspaceSessionRevoked(userId, payload.sid)) {
      throw Object.assign(new Error("Sessão revogada"), { statusCode: 401 });
    }
    if (current.rows[0].must_change_password && !options.allowPasswordChangeRequired) {
      throw Object.assign(new Error("Altere sua senha para continuar"), { statusCode: 428 });
    }
    return {
      userId,
      tenantId: payload.tenantId ? String(payload.tenantId) : undefined,
      email: current.rows[0].email,
      isRoot: current.rows[0].is_root,
      sessionVersion: current.rows[0].session_version,
      rootWorkspaceAccess: payload.rootWorkspaceAccess === true,
      mustChangePassword: current.rows[0].must_change_password,
      // B2 Security: repassa o sid da linha workspace_sessions para as rotas
      // de sessões (lista marca a atual; revoke-others preserva a própria).
      sid: typeof payload.sid === "string" ? payload.sid : undefined
    };
  } catch (error) {
    if (error instanceof errors.JOSEError) {
      throw Object.assign(new Error("Sessão inválida"), { statusCode: 401 });
    }
    throw error;
  }
}

export async function requireWorkspace(request: FastifyRequest): Promise<WorkspaceSession> {
  const identity = await requireIdentity(request);
  if (!identity.tenantId) throw Object.assign(new Error("Workspace ativo não selecionado"), { statusCode: 409 });

  if (identity.isRoot) {
    const workspace = await db.query<{ id: string }>(
      "SELECT id FROM tenants WHERE id=$1 AND status <> 'suspended'",
      [identity.tenantId]
    );
    if (!workspace.rows[0]) throw Object.assign(new Error("Workspace indisponível"), { statusCode: 403 });
    return {
      ...identity,
      tenantId: identity.tenantId,
      role: "ROOT",
      roleId: null,
      permissions: PERMISSIONS.map((permission) => permission.key),
      actorScope: "root",
      rootWorkspaceAccess: true
    };
  }

  const membership = await db.query<{ role_id: string; role: string; permission_key: PermissionKey | null }>(
    `SELECT r.id role_id,r.name role,rp.permission_key
     FROM workspace_members m
     JOIN workspace_roles r ON r.id=m.role_id AND r.workspace_id=m.workspace_id
     LEFT JOIN workspace_role_permissions rp ON rp.role_id=r.id
     JOIN tenants t ON t.id=m.workspace_id
     WHERE m.user_id=$1 AND m.workspace_id=$2 AND m.status='active' AND t.status <> 'suspended'
     ORDER BY rp.permission_key`,
    [identity.userId, identity.tenantId]
  );
  if (!membership.rows[0]) throw Object.assign(new Error("Workspace não autorizado"), { statusCode: 403 });
  return {
    ...identity,
    tenantId: identity.tenantId,
    role: membership.rows[0].role,
    roleId: membership.rows[0].role_id,
    permissions: membership.rows.flatMap((row) => row.permission_key ? [row.permission_key] : []),
    actorScope: "workspace"
  };
}

export async function requirePermission(request: FastifyRequest, permission: PermissionKey): Promise<WorkspaceSession> {
  const session = await requireWorkspace(request);
  if (session.isRoot) {
    if (session.rootWorkspaceAccess) return session;
    throw Object.assign(new Error("Permissão insuficiente"), { statusCode: 403 });
  }
  if (!session.permissions.includes(permission)) {
    throw Object.assign(new Error("Permissão insuficiente"), { statusCode: 403 });
  }
  return session;
}

export async function requireRootWorkspace(request: FastifyRequest): Promise<WorkspaceSession> {
  const session = await requireWorkspace(request);
  if (!session.isRoot || !session.rootWorkspaceAccess) throw Object.assign(new Error("ROOT obrigatório"), { statusCode: 403 });
  return session;
}

export async function requireRoot(request: FastifyRequest): Promise<IdentitySession> {
  const identity = await requireIdentity(request);
  const result = await db.query<{ is_root: boolean; status: string }>("SELECT is_root,status FROM users WHERE id=$1", [identity.userId]);
  if (!result.rows[0]?.is_root || result.rows[0].status !== "active") throw Object.assign(new Error("ROOT obrigatório"), { statusCode: 403 });
  return { ...identity, isRoot: true };
}

export const requireSession = requireWorkspace;
