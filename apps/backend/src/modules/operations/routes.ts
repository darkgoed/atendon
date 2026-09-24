import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import { requirePermission, requireRoot, requireSession } from "../../auth/session.js";
import { db } from "../../db/client.js";
import {
  deleteTenantFeatureFlagOverride,
  effectiveFeatureFlagMap,
  capabilityKeySchema,
  featureFlagKeySchema,
  listEffectiveCapabilities,
  listEffectiveFeatureFlags,
  listGlobalFeatureFlags,
  setFeatureFlagKillSwitch,
  setGlobalFeatureFlag,
  setTenantFeatureFlagOverride,
  type CapabilityKey
} from "./feature-flags.js";

const globalBody = z.object({ enabled: z.boolean().nullable() }).strict();
const killSwitchBody = z.object({ enabled: z.boolean() }).strict();
const overrideBody = z.object({ enabled: z.boolean() }).strict();
// Tenant manager toggle for R1 (AI meeting confirmation). Flag key and tenant
// are never taken from the request: the route always acts on the caller's own
// tenant via requirePermission("agent.manage").
const aiMeetingConfirmationBody = z.object({ enabled: z.boolean() }).strict();
const AI_MEETING_CONFIRMATION_FLAG = "scheduling_meeting_confirmation_v1";
const flagParams = z.object({ key: featureFlagKeySchema });
const tenantFlagParams = z.object({
  tenantId: z.string().uuid(),
  key: featureFlagKeySchema
});
const tenantParams = z.object({ tenantId: z.string().uuid() });
const capabilityBatchBody = z.object({
  changes: z.array(z.object({
    key: capabilityKeySchema,
    override: z.boolean().nullable()
  }).strict()).min(1).max(50),
  confirmCascade: z.boolean().optional().default(false)
}).strict().superRefine((body, context) => {
  const seen = new Set<string>();
  for (const [index, change] of body.changes.entries()) {
    if (seen.has(change.key)) {
      context.addIssue({ code: "custom", path: ["changes", index, "key"], message: "Capability duplicada no lote" });
    }
    seen.add(change.key);
  }
});

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

function capabilityError(statusCode: number, code: string, message: string, feature?: string) {
  return Object.assign(new Error(message), { statusCode, code, feature });
}

async function requireTenant(client: pg.Pool | pg.PoolClient, tenantId: string) {
  const tenant = await client.query<{ id: string }>("SELECT id FROM tenants WHERE id=$1", [tenantId]);
  if (!tenant.rows[0]) throw httpError(404, "Workspace não encontrado");
}

async function auditRootFlagChange(
  client: pg.PoolClient,
  request: FastifyRequest,
  input: {
    actorUserId: string;
    workspaceId?: string | null;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata: Record<string, unknown>;
    operationGroup?: string | null;
  }
) {
  await client.query(
    `INSERT INTO audit_logs(
       actor_user_id,workspace_id,actor_scope,action,resource_type,
       resource_id,metadata,ip_address,user_agent,operation_group
     ) VALUES($1,$2,'root',$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.actorUserId,
      input.workspaceId ?? null,
      input.action,
      input.resourceType,
      input.resourceId,
      input.metadata,
      request.ip,
      typeof request.headers["user-agent"] === "string"
        ? request.headers["user-agent"]
        : null,
      input.operationGroup ?? null
    ]
  );
}

export async function registerOperationsRoutes(app: FastifyInstance) {
  app.get("/feature-flags", async (request) => {
    const session = await requireSession(request);
    const flags = await listEffectiveFeatureFlags(db, session.tenantId);
    return { flags: effectiveFeatureFlagMap(flags) };
  });

  app.put("/settings/ai-meeting-confirmation", async (request) => {
    const session = await requirePermission(request, "agent.manage");
    const body = aiMeetingConfirmationBody.parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const changed = await setTenantFeatureFlagOverride(
        client,
        session.tenantId,
        AI_MEETING_CONFIRMATION_FLAG,
        body.enabled,
        session.userId
      );
      await client.query(
        `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
         VALUES($1,$2,$3,'feature_flag.tenant_override.update','feature_flag_override',$4,$5,$6,$7)`,
        [
          session.userId,
          session.tenantId,
          session.actorScope,
          AI_MEETING_CONFIRMATION_FLAG,
          { previous_enabled: changed.previous, enabled: changed.current },
          request.ip,
          typeof request.headers["user-agent"] === "string"
            ? request.headers["user-agent"]
            : null
        ]
      );
      const effective = (await listEffectiveFeatureFlags(client, session.tenantId))
        .find((flag) => flag.key === AI_MEETING_CONFIRMATION_FLAG);
      await client.query("COMMIT");
      return { enabled: effective?.enabled ?? body.enabled };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/capabilities", async (request) => {
    const session = await requireSession(request);
    return { capabilities: await listEffectiveCapabilities(db, session.tenantId) };
  });

  app.get("/root/feature-flags", async (request) => {
    await requireRoot(request);
    return { flags: await listGlobalFeatureFlags(db) };
  });

  app.get("/root/workspaces/:tenantId/feature-flags", async (request) => {
    await requireRoot(request);
    const { tenantId } = tenantParams.parse(request.params);
    await requireTenant(db, tenantId);
    return { flags: await listEffectiveFeatureFlags(db, tenantId) };
  });

  app.get("/root/workspaces/:tenantId/capabilities", async (request) => {
    await requireRoot(request);
    const { tenantId } = tenantParams.parse(request.params);
    await requireTenant(db, tenantId);
    return { capabilities: await listEffectiveCapabilities(db, tenantId) };
  });

  app.patch("/root/workspaces/:tenantId/capabilities", async (request, reply) => {
    const root = await requireRoot(request);
    const { tenantId } = tenantParams.parse(request.params);
    const body = capabilityBatchBody.parse(request.body);
    const operationGroup = randomUUID();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await requireTenant(client, tenantId);
      await client.query("SELECT flag_key FROM feature_flag_definitions WHERE kind='capability' FOR UPDATE");
      await client.query(
        "SELECT flag_key FROM tenant_feature_flag_overrides WHERE tenant_id=$1 FOR UPDATE",
        [tenantId]
      );

      const before = await listEffectiveCapabilities(client, tenantId);
      const beforeByKey = new Map(before.map((capability) => [capability.key, capability]));
      const explicit = new Map(body.changes.map((change) => [change.key, change.override]));
      for (const change of body.changes) {
        const capability = beforeByKey.get(change.key);
        if (!capability || !capability.tenantConfigurable) {
          throw capabilityError(400, "INVALID_CAPABILITY", "Capability não configurável", change.key);
        }
        if (change.override === true && !capability.supported) {
          throw capabilityError(409, "CAPABILITY_NOT_SUPPORTED", "Capability não provisionada para este workspace", change.key);
        }
      }
      for (const change of body.changes) {
        if (change.override !== true) continue;
        const capability = beforeByKey.get(change.key)!;
        for (const dependency of capability.dependencies) {
          const conflicting = explicit.get(dependency);
          if (conflicting === false || conflicting === null) {
            throw capabilityError(409, "CAPABILITY_DEPENDENCY_CONFLICT", "O lote desativa uma dependência necessária", dependency);
          }
        }
      }

      type AppliedChange = {
        key: CapabilityKey;
        previousOverride: boolean | null;
        override: boolean | null;
        reason: "direct" | "dependency_required" | "cascade";
      };
      const applied = new Map<string, AppliedChange>();
      const applyOverride = async (
        key: AppliedChange["key"],
        override: boolean | null,
        reason: AppliedChange["reason"]
      ) => {
        const previousOverride = applied.get(key)?.previousOverride ?? beforeByKey.get(key)!.tenantOverride;
        const currentOverride = applied.get(key)?.override ?? beforeByKey.get(key)!.tenantOverride;
        if (currentOverride === override) return;
        if (override === null) await deleteTenantFeatureFlagOverride(client, tenantId, key);
        else await setTenantFeatureFlagOverride(client, tenantId, key, override, root.userId);
        applied.set(key, { key, previousOverride, override, reason });
      };

      for (const change of body.changes) await applyOverride(change.key, change.override, "direct");

      // Enabling a dependent makes every disabled requirement explicit ON.
      for (let pass = 0; pass < before.length; pass += 1) {
        const provisional = await listEffectiveCapabilities(client, tenantId);
        const provisionalByKey = new Map(provisional.map((capability) => [capability.key, capability]));
        let changed = false;
        for (const change of body.changes) {
          if (change.override !== true) continue;
          const dependent = provisionalByKey.get(change.key)!;
          for (const dependencyKey of dependent.blockedBy) {
            const dependency = provisionalByKey.get(dependencyKey);
            if (!dependency?.supported || dependency?.killSwitchEnabled) {
              throw capabilityError(409, "CAPABILITY_DEPENDENCY_BLOCKED", "Dependência indisponível para ativação", dependencyKey);
            }
            await applyOverride(dependencyKey, true, "dependency_required");
            changed = true;
          }
        }
        if (!changed) break;
      }

      let provisional = await listEffectiveCapabilities(client, tenantId);
      const cascade = provisional.filter((capability) =>
        beforeByKey.get(capability.key)?.enabled === true
        && !capability.enabled
        && capability.source === "dependency"
        && !explicit.has(capability.key)
      );
      if (cascade.length > 0 && !body.confirmCascade) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          error: "Confirme a desativação das capabilities dependentes",
          code: "CAPABILITY_CASCADE_CONFIRMATION_REQUIRED",
          affectedCapabilities: cascade.map((capability) => capability.key)
        });
      }
      for (const capability of cascade) await applyOverride(capability.key, false, "cascade");

      provisional = await listEffectiveCapabilities(client, tenantId);
      const afterByKey = new Map(provisional.map((capability) => [capability.key, capability]));
      for (const change of applied.values()) {
        await auditRootFlagChange(client, request, {
          actorUserId: root.userId,
          workspaceId: tenantId,
          action: change.reason === "cascade"
            ? "capability.tenant_override.cascade"
            : "capability.tenant_override.update",
          resourceType: "capability_override",
          resourceId: change.key,
          operationGroup,
          metadata: {
            previous_override: change.previousOverride,
            override: change.override,
            previous_enabled: beforeByKey.get(change.key)?.enabled ?? false,
            enabled: afterByKey.get(change.key)?.enabled ?? false,
            reason: change.reason
          }
        });
      }
      await client.query("COMMIT");
      return {
        capabilities: provisional,
        changes: [...applied.values()],
        operationGroup
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.patch("/root/feature-flags/:key/global", async (request) => {
    const root = await requireRoot(request);
    const { key } = flagParams.parse(request.params);
    const body = globalBody.parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const changed = await setGlobalFeatureFlag(client, key, body.enabled, root.userId);
      await auditRootFlagChange(client, request, {
        actorUserId: root.userId,
        action: "feature_flag.global.update",
        resourceType: "feature_flag",
        resourceId: key,
        metadata: {
          previous_enabled: changed.previous.globalEnabled,
          enabled: changed.current.globalEnabled
        }
      });
      await client.query("COMMIT");
      return { flag: changed.current };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.patch("/root/feature-flags/:key/kill-switch", async (request) => {
    const root = await requireRoot(request);
    const { key } = flagParams.parse(request.params);
    const body = killSwitchBody.parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const changed = await setFeatureFlagKillSwitch(client, key, body.enabled, root.userId);
      await auditRootFlagChange(client, request, {
        actorUserId: root.userId,
        action: "feature_flag.kill_switch.update",
        resourceType: "feature_flag",
        resourceId: key,
        metadata: {
          previous_enabled: changed.previous.killSwitchEnabled,
          enabled: changed.current.killSwitchEnabled
        }
      });
      await client.query("COMMIT");
      return { flag: changed.current };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.put("/root/workspaces/:tenantId/feature-flags/:key/override", async (request) => {
    const root = await requireRoot(request);
    const { tenantId, key } = tenantFlagParams.parse(request.params);
    const body = overrideBody.parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await requireTenant(client, tenantId);
      const changed = await setTenantFeatureFlagOverride(
        client,
        tenantId,
        key,
        body.enabled,
        root.userId
      );
      await auditRootFlagChange(client, request, {
        actorUserId: root.userId,
        workspaceId: tenantId,
        action: "feature_flag.tenant_override.update",
        resourceType: "feature_flag_override",
        resourceId: key,
        metadata: {
          previous_enabled: changed.previous,
          enabled: changed.current
        }
      });
      const effective = (await listEffectiveFeatureFlags(client, tenantId))
        .find((flag) => flag.key === key);
      await client.query("COMMIT");
      return { flag: effective };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.delete("/root/workspaces/:tenantId/feature-flags/:key/override", async (request) => {
    const root = await requireRoot(request);
    const { tenantId, key } = tenantFlagParams.parse(request.params);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await requireTenant(client, tenantId);
      const changed = await deleteTenantFeatureFlagOverride(client, tenantId, key);
      await auditRootFlagChange(client, request, {
        actorUserId: root.userId,
        workspaceId: tenantId,
        action: "feature_flag.tenant_override.delete",
        resourceType: "feature_flag_override",
        resourceId: key,
        metadata: { previous_enabled: changed.previous, enabled: null }
      });
      const effective = (await listEffectiveFeatureFlags(client, tenantId))
        .find((flag) => flag.key === key);
      await client.query("COMMIT");
      return { flag: effective };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
