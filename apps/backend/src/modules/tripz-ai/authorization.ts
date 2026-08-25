import type { FastifyRequest } from "fastify";
import { requireWorkspace, type WorkspaceSession } from "../../auth/session.js";
import {
  resolveCapability,
  type FeatureFlagQueryable
} from "../operations/feature-flags.js";
import {
  TRIPZ_AI_FEATURE_FLAG,
  TRIPZ_AI_MANAGE_PERMISSION,
  TRIPZ_AI_USE_PERMISSION,
  TripzAiError,
  type TripzAccessScope
} from "./domain.js";

export interface TripzAuthorizedSession extends TripzAccessScope {
  actorScope: WorkspaceSession["actorScope"];
  isRoot: boolean;
}

export type TripzAuthorizer = (request: FastifyRequest) => Promise<TripzAuthorizedSession>;
export type TripzFeatureGate = (tenantId: string) => Promise<void>;

function hasPermission(session: WorkspaceSession, permission: string): boolean {
  return new Set<string>(session.permissions).has(permission);
}

export async function requireTripzAiPermission(request: FastifyRequest): Promise<TripzAuthorizedSession> {
  const session = await requireWorkspace(request);
  if (!session.isRoot && !hasPermission(session, TRIPZ_AI_USE_PERMISSION)) {
    throw new TripzAiError(403, "TRIPZ_PERMISSION_DENIED", "Permissão insuficiente");
  }
  return {
    tenantId: session.tenantId,
    userId: session.userId,
    canManage: session.isRoot || hasPermission(session, TRIPZ_AI_MANAGE_PERMISSION),
    actorScope: session.actorScope,
    isRoot: session.isRoot
  };
}

export function createTripzFeatureGate(database: FeatureFlagQueryable): TripzFeatureGate {
  return async (tenantId: string) => {
    const tenant = await database.query<{ status: string }>(
      "SELECT status FROM tenants WHERE id=$1",
      [tenantId]
    );
    const capability = tenant.rows[0]?.status === "active"
      ? await resolveCapability(database, tenantId, TRIPZ_AI_FEATURE_FLAG)
      : undefined;
    if (!capability?.enabled) {
      throw new TripzAiError(409, "FEATURE_FLAG_DISABLED", "Tripz IA está desabilitada neste workspace");
    }
  };
}

export async function authorizeTripzAiWorkerScope(
  database: FeatureFlagQueryable,
  scope: TripzAccessScope
): Promise<TripzAccessScope> {
  await createTripzFeatureGate(database)(scope.tenantId);
  const result = await database.query<{
    is_root: boolean;
    status: string;
    can_use: boolean;
    can_manage: boolean;
  }>(
    `SELECT actor.is_root,actor.status,
       EXISTS(
         SELECT 1 FROM workspace_members membership
         JOIN tenants tenant ON tenant.id=membership.workspace_id AND tenant.status <> 'suspended'
         JOIN workspace_role_permissions permission ON permission.role_id=membership.role_id
         WHERE membership.workspace_id=$1 AND membership.user_id=actor.id
           AND membership.status='active' AND permission.permission_key=$3
       ) can_use,
       EXISTS(
         SELECT 1 FROM workspace_members membership
         JOIN tenants tenant ON tenant.id=membership.workspace_id AND tenant.status <> 'suspended'
         JOIN workspace_role_permissions permission ON permission.role_id=membership.role_id
         WHERE membership.workspace_id=$1 AND membership.user_id=actor.id
           AND membership.status='active' AND permission.permission_key=$4
       ) can_manage
     FROM users actor WHERE actor.id=$2`,
    [scope.tenantId, scope.userId, TRIPZ_AI_USE_PERMISSION, TRIPZ_AI_MANAGE_PERMISSION]
  );
  const actor = result.rows[0];
  if (!actor || actor.status !== "active" || (!actor.is_root && !actor.can_use)) {
    throw new TripzAiError(403, "TRIPZ_PERMISSION_DENIED", "Acesso à Tripz IA foi revogado");
  }
  return { tenantId: scope.tenantId, userId: scope.userId, canManage: actor.is_root || actor.can_manage };
}
