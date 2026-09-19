import { randomUUID } from "node:crypto";
import pg from "pg";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearTotpChallenge,
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  issueTotpChallenge,
  loadTotpState,
  readTotpChallenge,
  totpAuthUrl,
  totpCode,
  verifyTotp
} from "../src/auth/totp.js";
import {
  createWorkspaceSessionRow,
  insertSecurityAudit,
  listWorkspaceSessions,
  revokeOtherSessions,
  revokeWorkspaceSession
} from "../src/auth/sessions.js";
import { createSessionToken, requireIdentity } from "../src/auth/session.js";
import { config } from "../src/config.js";

// B2 Security (b): integração dos módulos de TOTP + sessões ativas contra o
// banco de teste. Pool direto, tenant por arquivo, NUNCA registrar plugin —
// o registro das rotas em app.ts é do orquestrador; aqui validamos os módulos
// (auth/totp.ts, auth/sessions.ts, auth/session.ts) e o estado no banco.

const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });

let tenantId = "";
let aliceUserId = "";
let bobUserId = "";

function cookieReply(onCookie: (name: string, value: string) => void): FastifyReply {
  return { setCookie: onCookie } as unknown as FastifyReply;
}

function requestWithCookies(cookies: Record<string, string>): FastifyRequest {
  return { cookies } as unknown as FastifyRequest;
}

async function issueSession(userId: string, options: { tenantId?: string | null; sid?: string } = {}) {
  return createSessionToken({
    userId,
    tenantId: options.tenantId ?? tenantId,
    email: `user-${userId}@test.local`,
    role: "OPERADOR",
    isRoot: false,
    rootWorkspaceAccess: false,
    ...(options.sid ? { sid: options.sid } : {})
  });
}

beforeAll(async () => {
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','UTC') RETURNING id",
    [`Totp sessions ${randomUUID()}`]
  )).rows[0].id;
  aliceUserId = (await pool.query<{ id: string }>(
    "INSERT INTO users(email,status,name) VALUES($1,'active','Alice Totp') RETURNING id",
    [`alice-totp-${randomUUID()}@test.local`]
  )).rows[0].id;
  bobUserId = (await pool.query<{ id: string }>(
    "INSERT INTO users(email,status,name) VALUES($1,'active','Bob Totp') RETURNING id",
    [`bob-totp-${randomUUID()}@test.local`]
  )).rows[0].id;
});

afterAll(async () => {
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])", [[aliceUserId, bobUserId]]);
  // workspace_sessions e membros caem por cascade dos usuários/tenant.
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[aliceUserId, bobUserId]]);
  await pool.end();
});

beforeEach(async () => {
  // Cada teste começa sem sessões/auditoria — evita contaminação de contagem.
  await pool.query("DELETE FROM workspace_sessions WHERE user_id=ANY($1::uuid[])", [[aliceUserId, bobUserId]]);
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])", [[aliceUserId, bobUserId]]);
});

describe("TOTP (RFC 6238)", () => {
  it("validates the current code and rejects a future one", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const now = new Date();
    expect(verifyTotp(secret, totpCode(secret, now), now)).toBe(true);
    // ±1 período cobre deriva de relógio.
    expect(verifyTotp(secret, totpCode(secret, new Date(now.getTime() - 20_000)), now)).toBe(true);
    // Código de +5 minutos (counter+10) está fora da janela.
    expect(verifyTotp(secret, totpCode(secret, new Date(now.getTime() + 5 * 60_000)), now)).toBe(false);
    expect(verifyTotp(secret, "12345", now)).toBe(false);
    expect(verifyTotp(secret, "abcdefgh", now)).toBe(false);
  });

  it("builds an otpauth URL with issuer, account and secret", () => {
    const secret = generateTotpSecret();
    const url = totpAuthUrl(secret, "alice@test.local");
    expect(url.startsWith("otpauth://totp/")).toBe(true);
    expect(url).toContain("AtendON%3Aalice%40test.local");
    expect(url).toContain(`secret=${secret}`);
    expect(url).toContain("issuer=AtendON");
  });

  it("stores the secret encrypted and activation flips the flag", async () => {
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret);
    expect(encrypted).not.toContain(secret);
    await pool.query(
      "UPDATE users SET totp_secret_encrypted=$2,totp_enabled_at=NULL WHERE id=$1",
      [aliceUserId, encrypted]
    );
    let state = await loadTotpState(aliceUserId);
    expect(state.enabled).toBe(false);
    expect(state.secretBase32).toBe(secret); // decryptTotpSecret round-trip
    expect(decryptTotpSecret(encrypted)).toBe(secret);
    // Ativação (mesma transição de POST /me/totp/activate).
    await pool.query("UPDATE users SET totp_enabled_at=now() WHERE id=$1", [aliceUserId]);
    state = await loadTotpState(aliceUserId);
    expect(state.enabled).toBe(true);
    expect(state.secretBase32).toBe(secret);
    await pool.query(
      "UPDATE users SET totp_secret_encrypted=NULL,totp_enabled_at=NULL WHERE id=$1",
      [aliceUserId]
    );
    state = await loadTotpState(aliceUserId);
    expect(state).toEqual({ enabled: false, secretBase32: null });
  });
});

describe("TOTP login challenge", () => {
  it("issues a challenge that requireIdentity rejects but verify can read", async () => {
    let challengeToken = "";
    await issueTotpChallenge(cookieReply((name, value) => {
      expect(name).toBe("atendon_totp_challenge");
      challengeToken = value;
    }), aliceUserId);
    expect(challengeToken).not.toBe("");

    // O desafio NÃO é sessão: requireIdentity o rejeita (invariante B2).
    await expect(requireIdentity(requestWithCookies({ atendon_session: challengeToken })))
      .rejects.toMatchObject({ statusCode: 401, message: "Conclua a verificação em duas etapas" });

    // /auth/totp/verify lê o userId do desafio.
    expect(await readTotpChallenge(requestWithCookies({ atendon_totp_challenge: challengeToken })))
      .toBe(aliceUserId);

    clearTotpChallenge({ clearCookie: () => undefined } as unknown as FastifyReply);
  });

  it("rejects a missing or garbage challenge cookie", async () => {
    await expect(readTotpChallenge(requestWithCookies({})))
      .rejects.toMatchObject({ statusCode: 401 });
    await expect(readTotpChallenge(requestWithCookies({ atendon_totp_challenge: "garbage" })))
      .rejects.toMatchObject({ statusCode: 401 });
  });
});

describe("workspace_sessions", () => {
  it("records each emitted session and requireIdentity accepts a live sid", async () => {
    const sid = await createWorkspaceSessionRow({
      userId: aliceUserId,
      tenantId,
      kind: "session",
      ip: "127.0.0.1",
      userAgent: "vitest"
    });
    const token = await issueSession(aliceUserId, { sid });
    const identity = await requireIdentity(requestWithCookies({ atendon_session: token }));
    expect(identity.userId).toBe(aliceUserId);
    expect(identity.tenantId).toBe(tenantId);
    expect(identity.sid).toBe(sid);
  });

  it("lists only the user's active sessions and marks the current one", async () => {
    const first = await createWorkspaceSessionRow({ userId: aliceUserId, tenantId });
    const second = await createWorkspaceSessionRow({ userId: aliceUserId, tenantId });
    const third = await createWorkspaceSessionRow({ userId: bobUserId, tenantId });

    const items = await listWorkspaceSessions(aliceUserId, second);
    expect(items.map((item) => item.id)).toEqual(expect.arrayContaining([first, second]));
    expect(items.find((item) => item.id === second)?.current).toBe(true);
    expect(items.filter((item) => !item.current).map((item) => item.id)).toEqual(expect.arrayContaining([first]));
    // Sessão de OUTRO usuário nunca aparece (isolamento por user_id).
    expect(items.some((item) => item.id === third)).toBe(false);
    expect(items.every((item) => item.ip_address === null && item.user_agent === null)).toBe(true);
  });

  it("revokes a single session by its owner only", async () => {
    const own = await createWorkspaceSessionRow({ userId: aliceUserId, tenantId });
    const foreign = await createWorkspaceSessionRow({ userId: bobUserId, tenantId });

    // Bob NÃO pode revogar a sessão da Alice (escopo por user_id).
    expect(await revokeWorkspaceSession(bobUserId, own)).toBe(false);
    expect(await revokeWorkspaceSession(aliceUserId, foreign)).toBe(false);

    expect(await revokeWorkspaceSession(aliceUserId, own)).toBe(true);
    // Já revogada: segunda revogação não encontra linha.
    expect(await revokeWorkspaceSession(aliceUserId, own)).toBe(false);

    const token = await issueSession(aliceUserId, { sid: own });
    await expect(requireIdentity(requestWithCookies({ atendon_session: token })))
      .rejects.toMatchObject({ statusCode: 401, message: "Sessão revogada" });
    expect((await listWorkspaceSessions(aliceUserId, null)).some((item) => item.id === own)).toBe(false);
  });

  it("revoke-others keeps the current session and spares other users", async () => {
    const current = await createWorkspaceSessionRow({ userId: aliceUserId, tenantId });
    await createWorkspaceSessionRow({ userId: aliceUserId, tenantId });
    await createWorkspaceSessionRow({ userId: aliceUserId, tenantId });
    const bobSession = await createWorkspaceSessionRow({ userId: bobUserId, tenantId });

    expect(await revokeOtherSessions(aliceUserId, current)).toBe(2);
    // Sessão atual permanece viva e aceita.
    const identity = await requireIdentity(requestWithCookies({
      atendon_session: await issueSession(aliceUserId, { sid: current })
    }));
    expect(identity.sid).toBe(current);
    const remaining = await listWorkspaceSessions(aliceUserId, current);
    expect(remaining.map((item) => item.id)).toEqual([current]);
    // Sessão de Bob não é tocada.
    expect(await listWorkspaceSessions(bobUserId, bobSession)).toHaveLength(1);
    expect(await revokeOtherSessions(aliceUserId, current)).toBe(0);
  });

  it("treats an expired session as revoked", async () => {
    const sid = await createWorkspaceSessionRow({ userId: aliceUserId, tenantId });
    await pool.query("UPDATE workspace_sessions SET created_at=now()-interval '2 hours', expires_at=now()-interval '1 minute' WHERE id=$1", [sid]);
    const token = await issueSession(aliceUserId, { sid });
    await expect(requireIdentity(requestWithCookies({ atendon_session: token })))
      .rejects.toMatchObject({ statusCode: 401, message: "Sessão revogada" });
  });

  it("persists security audit rows for totp/session events", async () => {
    await insertSecurityAudit(pool, {
      actorUserId: aliceUserId,
      workspaceId: tenantId,
      actorScope: "workspace",
      action: "totp.setup",
      resourceId: aliceUserId,
      metadata: { source: "integration-test" },
      ipAddress: "127.0.0.1",
      userAgent: "vitest"
    });
    const row = (await pool.query<{ action: string; resource_type: string; metadata: Record<string, unknown> }>(
      `SELECT action,resource_type,metadata FROM audit_logs
       WHERE actor_user_id=$1 AND action='totp.setup' ORDER BY created_at DESC LIMIT 1`,
      [aliceUserId]
    )).rows[0];
    expect(row.resource_type).toBe("user");
    expect(row.metadata).toMatchObject({ source: "integration-test" });
  });
});
