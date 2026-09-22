// F3-r1 — app local de teste para o módulo changelog (app.ts é proibido/intocado, A11).
// Padrão dos testes de módulo: Fastify() local + plugin do módulo registrado.
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { createSessionToken } from "../../src/auth/session.js";
import { ensureWorkspaceDefaultRoles } from "../../src/auth/rbac.js";
import { registerChangelogRoutes } from "../../src/modules/changelog/routes.js";

export function buildChangelogApp(): FastifyInstance {
  const app = Fastify({ bodyLimit: 12 * 1024 * 1024 });
  app.register(cookie);
  app.register(registerChangelogRoutes);
  return app;
}

export async function sessionCookieFor(userId: string, email: string, isRoot: boolean, tenantId?: string): Promise<string> {
  const token = await createSessionToken({ userId, email, isRoot, ...(tenantId ? { tenantId } : {}) });
  return `atendon_session=${token}`;
}

export async function insertUser(pool: Pool, isRoot: boolean, email?: string): Promise<{ id: string; email: string }> {
  const address = email ?? `changelog-${randomUUID()}@test.local`;
  const result = await pool.query<{ id: string }>(
    "INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',$3) RETURNING id",
    [address, "not-a-real-login-hash", isRoot]
  );
  return { id: result.rows[0].id, email: address };
}

export async function createTenant(pool: Pool): Promise<string> {
  return (await pool.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [
    `Changelog ${randomUUID()}`
  ])).rows[0].id;
}

export async function createWorkspaceUser(pool: Pool, tenantId: string): Promise<{ id: string; email: string }> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    const user = await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",
      [`changelog-ws-${randomUUID()}@test.local`, "not-a-real-login-hash"]
    );
    const role = await client.query<{ id: string }>(
      "SELECT id FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'",
      [tenantId]
    );
    await client.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())",
      [tenantId, user.rows[0].id, role.rows[0].id]
    );
    await client.query("COMMIT");
    return { id: user.rows[0].id, email: `changelog-ws-${user.rows[0].id.slice(0, 8)}@test.local` };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface MultipartField {
  name: string;
  value?: string;
  filename?: string;
  mime?: string;
  data?: Buffer;
}

export function multipartBody(fields: MultipartField[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----changelogtest${randomUUID().replaceAll("-", "")}`;
  const parts: Buffer[] = [];
  for (const field of fields) {
    if (field.data !== undefined) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"; filename="${field.filename ?? "file"}"\r\nContent-Type: ${field.mime ?? "application/octet-stream"}\r\n\r\n`
      ));
      parts.push(field.data);
      parts.push(Buffer.from("\r\n"));
    } else {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value ?? ""}\r\n`));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` }
  };
}

// NONCE aleatório por chamada: sha256 é UNIQUE em changelog_media — bytes determinísticos
// colidem entre arquivos de teste em paralelo (409 cruzado) e entre execuções (ETag/304 cruzado).
function withNonce(bytes: Buffer): Buffer {
  return Buffer.concat([bytes, randomBytes(12)]);
}
export function pngBytes(): Buffer {
  return withNonce(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 7)]));
}
export function jpegBytes(): Buffer {
  return withNonce(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 3)]));
}
export function gifBytes(): Buffer {
  return withNonce(Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(24, 1)]));
}
export function webpBytes(): Buffer {
  return withNonce(Buffer.concat([Buffer.from("RIFF\x00\x00\x00\x00WEBP", "latin1"), Buffer.alloc(16, 2)]));
}
export function mp4Bytes(): Buffer {
  return withNonce(Buffer.concat([Buffer.alloc(4, 0), Buffer.from("ftypisom", "latin1"), Buffer.alloc(16, 4)]));
}
export function svgBytes(): Buffer {
  return Buffer.from(`<!--${randomUUID()}--><svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>`);
}
export function htmlBytes(): Buffer {
  return Buffer.from(`<!--${randomUUID()}--><html><body>ola</body></html>`);
}
export function exeBytes(): Buffer {
  return withNonce(Buffer.concat([Buffer.from("MZ", "latin1"), Buffer.alloc(32, 0)]));
}
