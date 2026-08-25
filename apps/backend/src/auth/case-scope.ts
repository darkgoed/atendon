import type { Pool, PoolClient } from "pg";
import type { WorkspaceSession } from "./session.js";

export type CaseScope =
  | { type: "workspace"; userId: string; memberId: null }
  | { type: "mine"; userId: string; memberId: string | null };

export function hasWorkspaceCaseAccess(session: WorkspaceSession): boolean {
  return session.isRoot === true || ["ROOT", "OWNER", "ADMIN", "SUPERVISOR"].includes(session.role.trim().toUpperCase());
}

export async function resolveCaseScope(
  connection: Pick<Pool | PoolClient, "query">,
  session: WorkspaceSession
): Promise<CaseScope> {
  if (hasWorkspaceCaseAccess(session)) {
    return { type: "workspace", userId: session.userId, memberId: null };
  }
  const membership = await connection.query<{ id: string }>(
    `SELECT id
     FROM workspace_members
     WHERE workspace_id=$1 AND user_id=$2 AND status='active'
     LIMIT 1`,
    [session.tenantId, session.userId]
  );
  return { type: "mine", userId: session.userId, memberId: membership.rows[0]?.id ?? null };
}

export function conversationScopeCondition(scope: CaseScope, alias: string, userParameter: string): string {
  // Keep the caller's user parameter part of the statement for both scope
  // variants. This lets routes use one stable parameter list.
  return scope.type === "workspace"
    ? `(${userParameter}::uuid IS NULL OR ${userParameter}::uuid IS NOT NULL)`
    : `${alias}.assigned_user_id=${userParameter}`;
}

export function leadScopeCondition(scope: CaseScope, alias: string, memberParameter: string): string {
  return scope.type === "workspace"
    ? `(${memberParameter}::uuid IS NULL OR ${memberParameter}::uuid IS NOT NULL)`
    : `${alias}.assigned_member_id=${memberParameter}`;
}

export function appointmentScopeCondition(scope: CaseScope, alias: string, memberParameter: string): string {
  return scope.type === "workspace"
    ? `(${memberParameter}::uuid IS NULL OR ${memberParameter}::uuid IS NOT NULL)`
    : `${alias}.assigned_member_id=${memberParameter}`;
}

export async function canAccessConversation(
  connection: Pick<Pool | PoolClient, "query">,
  session: WorkspaceSession,
  conversationId: string
): Promise<boolean> {
  const scope = await resolveCaseScope(connection, session);
  const result = await connection.query(
    `SELECT 1
     FROM conversations conversation
     WHERE conversation.id=$1
       AND conversation.tenant_id=$2
       AND (${conversationScopeCondition(scope, "conversation", "$3")})
     LIMIT 1`,
    [conversationId, session.tenantId, scope.userId]
  );
  return Boolean(result.rows[0]);
}
