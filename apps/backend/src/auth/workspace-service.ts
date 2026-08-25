import { hash } from "bcryptjs";
import type { Pool } from "pg";
import { db } from "../db/client.js";
import { PERMISSIONS } from "./rbac.js";

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  role: string;
  timezone: string;
}

export interface UserIdentity {
  id: string;
  email: string;
  isRoot: boolean;
}

export async function listWorkspacesForUser(pool: Pool, userId: string, isRoot: boolean): Promise<WorkspaceSummary[]> {
  if (isRoot) {
    const result = await pool.query<WorkspaceSummary>(
      `SELECT id,name,COALESCE(slug,id::text) slug,status,'ROOT' role,timezone
       FROM tenants WHERE status <> 'suspended' ORDER BY name`
    );
    return result.rows;
  }
  const result = await pool.query<WorkspaceSummary>(
    `SELECT t.id,t.name,COALESCE(t.slug,t.id::text) slug,t.status,r.name role,t.timezone
     FROM workspace_members m
     JOIN tenants t ON t.id=m.workspace_id
     JOIN workspace_roles r ON r.id=m.role_id
     WHERE m.user_id=$1 AND m.status='active' AND t.status <> 'suspended'
     ORDER BY t.name`,
    [userId]
  );
  return result.rows;
}

export async function buildMePayload(session: {
  userId: string;
  email: string;
  isRoot: boolean;
  tenantId: string;
  role: string;
  permissions: string[];
  actorScope: "root" | "workspace";
  rootWorkspaceAccess?: boolean;
}) {
  const rootWorkspaceAccess = session.isRoot && session.actorScope === "root"
    ? true
    : session.rootWorkspaceAccess ?? false;
  const permissions = rootWorkspaceAccess
    ? PERMISSIONS.map((permission) => permission.key)
    : session.permissions;
  const [workspaces, active, user] = await Promise.all([
    listWorkspacesForUser(db, session.userId, session.isRoot),
    db.query<{ id: string; name: string; slug: string; status: string; timezone: string }>(
      "SELECT id,name,COALESCE(slug,id::text) slug,status,timezone FROM tenants WHERE id=$1",
      [session.tenantId]
    ),
    db.query<{ name: string | null; must_change_password: boolean }>(
      "SELECT name,must_change_password FROM users WHERE id=$1",
      [session.userId]
    )
  ]);
  return {
    user: {
      id: session.userId,
      email: session.email,
      isRoot: session.isRoot,
      name: user.rows[0]?.name ?? null,
      mustChangePassword: user.rows[0]?.must_change_password ?? false
    },
    activeWorkspace: active.rows[0] ? { ...active.rows[0], role: session.role } : null,
    workspaces,
    permissions,
    actorScope: session.actorScope,
    rootWorkspaceAccess
  };
}

export async function createRootUser(pool: Pool, email: string, password: string): Promise<UserIdentity> {
  const passwordHash = await hash(password, 12);
  const result = await pool.query<{ id: string; email: string; is_root: boolean }>(
    `INSERT INTO users(email,password_hash,status,is_root)
     VALUES($1,$2,'active',true)
     ON CONFLICT(email) DO UPDATE SET
       is_root=true,
       status=CASE WHEN users.status='disabled' THEN users.status ELSE 'active' END,
       password_hash=COALESCE(users.password_hash,EXCLUDED.password_hash),
       updated_at=now()
     RETURNING id,email,is_root`,
    [email.toLocaleLowerCase("en-US"), passwordHash]
  );
  return { id: result.rows[0].id, email: result.rows[0].email, isRoot: result.rows[0].is_root };
}
