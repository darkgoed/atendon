import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { createSessionToken, requireRoot } from "../../auth/session.js";
import { ensureWorkspaceDefaultRoles } from "../../auth/rbac.js";
import { buildMePayload } from "../../auth/workspace-service.js";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { getEmailProvider } from "../../mail/index.js";
import { buildInvitationAcceptUrl, createInvitationToken, sendWorkspaceInvitationEmail, shouldExposeInvitationToken } from "../../mail/invitations.js";
import { DEFAULT_MEDIA_FALLBACK } from "../ai-router/defaults.js";
import { DEFAULT_HUMANIZER_CONFIG } from "../messages/humanizer.js";
import { collectOperationalSnapshot } from "../operations/operational-snapshot.js";
import { listEffectiveCapabilities } from "../operations/feature-flags.js";
import { httpError } from "../scheduling/service.js";
import { HTTP_RATE_LIMITS } from "../../security/http-rate-limit.js";

const uuid = z.string().uuid();
const workspaceBody = z.object({
  name: z.string().trim().min(2).max(200),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120).optional(),
  ownerEmail: z.string().email(),
  capabilityTemplateTenantId: z.string().uuid().optional(),
  planId: z.string().uuid().optional(),
  planCode: z.string().trim().min(1).max(80).optional()
}).refine((value) => !(value.planId && value.planCode), "Informe planId ou planCode, não ambos");
const workspaceUpdateBody = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  status: z.enum(["trial", "active", "suspended"]).optional(),
  attendantPhone: z.string().trim().max(40).nullable().optional()
}).refine((value) => value.name || value.status || value.attendantPhone !== undefined, "Informe um campo para atualizar");
const workspaceParams = z.object({ id: uuid });

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function slugify(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || `workspace-${randomBytes(4).toString("hex")}`;
}

async function audit(request: FastifyRequest, input: { action: string; workspaceId?: string | null; resourceType: string; resourceId?: string | null; metadata?: Record<string, unknown> }) {
  const root = await requireRoot(request);
  await db.query(
    `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
     VALUES($1,$2,'root',$3,$4,$5,$6,$7,$8)`,
    [
      root.userId,
      input.workspaceId ?? null,
      input.action,
      input.resourceType,
      input.resourceId ?? null,
      input.metadata ?? {},
      request.ip,
      typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null
    ]
  );
}

export async function registerRootRoutes(app: FastifyInstance) {
  app.get("/root/workspaces", async (request) => {
    await requireRoot(request);
    const result = await db.query(
      `SELECT t.id,t.name,t.slug,t.status,t.attendant_phone,t.created_at,t.updated_at,
              COALESCE(m.member_count,0)::int member_count,
              COALESCE(i.pending_invites,0)::int pending_invites
       FROM tenants t
       LEFT JOIN (
         SELECT workspace_id,count(*)::int member_count
         FROM workspace_members
         GROUP BY workspace_id
       ) m ON m.workspace_id=t.id
       LEFT JOIN (
         SELECT workspace_id,count(*)::int pending_invites
         FROM workspace_invitations
         WHERE status='pending' AND expires_at > now()
         GROUP BY workspace_id
       ) i ON i.workspace_id=t.id
       ORDER BY t.created_at DESC
       LIMIT 500`
    );
    return { workspaces: result.rows };
  });

  app.post("/root/workspaces", { config: { rateLimit: HTTP_RATE_LIMITS.sensitiveWrite } }, async (request, reply) => {
    const root = await requireRoot(request);
    const body = workspaceBody.parse(request.body);
    const emailProvider = getEmailProvider();
    const token = createInvitationToken();
    const client = await db.connect();
    let inTransaction = false;
    try {
      await client.query("BEGIN");
      inTransaction = true;
      const plan = await client.query<{ id: string; code: string; trial_days: number; billing_period_months: number }>(
        `SELECT id,code,trial_days,billing_period_months FROM plans
         WHERE status='active' AND (
           ($1::uuid IS NOT NULL AND id=$1::uuid)
           OR ($2::text IS NOT NULL AND code=$2::text)
           OR ($1::uuid IS NULL AND $2::text IS NULL AND is_default=true)
         )
         ORDER BY CASE WHEN $1::uuid IS NOT NULL AND id=$1::uuid THEN 0 WHEN $2::text IS NOT NULL AND code=$2::text THEN 1 ELSE 2 END
         LIMIT 1`,
        [body.planId ?? null, body.planCode ?? null]
      );
      // O plano padrão é dado (`plans.is_default`), nunca um código conhecido
      // pela aplicação. A constraint garante que seja público, ativo e pago.
      if (!plan.rows[0]) throw httpError(404, "Plano não encontrado, inativo ou plano comercial padrão não configurado");
      const templateCapabilities = body.capabilityTemplateTenantId
        ? await (async () => {
          const template = await client.query<{ id: string }>("SELECT id FROM tenants WHERE id=$1 FOR SHARE", [body.capabilityTemplateTenantId]);
          if (!template.rows[0]) throw httpError(404, "Workspace-modelo não encontrado");
          return listEffectiveCapabilities(client, body.capabilityTemplateTenantId!);
        })()
        : null;
      const baseSlug = body.slug ?? slugify(body.name);
      const workspace = await client.query<{ id: string; slug: string }>(
        `INSERT INTO tenants(name,slug,status,created_by_user_id)
         VALUES($1,$2,'active',$3)
         RETURNING id,slug`,
        [body.name, `${baseSlug}-${randomBytes(3).toString("hex")}`, root.userId]
      );
      await client.query(
        `INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end,trial_ends_at)
         VALUES($1,$2,CASE WHEN $3 > 0 THEN 'TRIALING' ELSE 'ACTIVE' END,now(),now() + make_interval(months => $4),CASE WHEN $3 > 0 THEN now() + make_interval(days => $3) ELSE NULL END)
         RETURNING id`,
        [workspace.rows[0].id, plan.rows[0].id, plan.rows[0].trial_days, plan.rows[0].billing_period_months]
      );
      await ensureWorkspaceDefaultRoles(client, workspace.rows[0].id);
      const ownerRole = await client.query<{ id: string }>(
        "SELECT id FROM workspace_roles WHERE workspace_id=$1 AND is_owner_role=true",
        [workspace.rows[0].id]
      );
      const invitation = await client.query<{ id: string; expires_at: string }>(
        `INSERT INTO workspace_invitations(workspace_id,email,role_id,token_hash,status,expires_at,invited_by_user_id)
         VALUES($1,lower($2),$3,$4,'pending',now() + interval '7 days',$5)
         RETURNING id,expires_at`,
        [workspace.rows[0].id, body.ownerEmail, ownerRole.rows[0].id, tokenHash(token), root.userId]
      );
      const session = await client.query<{ id: string }>(
        "INSERT INTO whatsapp_sessions(tenant_id,label,is_primary) VALUES($1,'Principal',true) RETURNING id",
        [workspace.rows[0].id]
      );
      await client.query(
        "INSERT INTO agent_configs(tenant_id,system_prompt,ai_model,model_params) VALUES($1,$2,$3,$4)",
        [workspace.rows[0].id, config.DEFAULT_SYSTEM_PROMPT, config.DEFAULT_AI_MODEL, { temperature: 0.4, max_tokens: 512 }]
      );
      await client.query(
        `INSERT INTO tenant_ai_settings(tenant_id,media_fallback_audio,media_fallback_image,media_fallback_document,humanizer_config)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(tenant_id) DO UPDATE SET
           media_fallback_audio=COALESCE(tenant_ai_settings.media_fallback_audio,EXCLUDED.media_fallback_audio),
           media_fallback_image=COALESCE(tenant_ai_settings.media_fallback_image,EXCLUDED.media_fallback_image),
           media_fallback_document=COALESCE(tenant_ai_settings.media_fallback_document,EXCLUDED.media_fallback_document),
           humanizer_config=COALESCE(tenant_ai_settings.humanizer_config,EXCLUDED.humanizer_config),
           updated_at=now()`,
        [workspace.rows[0].id, DEFAULT_MEDIA_FALLBACK.audio, DEFAULT_MEDIA_FALLBACK.image, DEFAULT_MEDIA_FALLBACK.document, DEFAULT_HUMANIZER_CONFIG]
      );
      const copiedCapabilities = templateCapabilities
        ? templateCapabilities.filter((capability) => capability.supported && capability.availabilityMode === "all_tenants")
        : (await client.query<{ key: string; enabled: boolean }>(
          `SELECT d.flag_key AS key, COALESCE(pf.enabled,false) AS enabled
             FROM feature_flag_definitions d
             LEFT JOIN plan_capability_flags pf ON pf.plan_id=$1 AND pf.flag_key=d.flag_key
            WHERE d.kind='capability' ORDER BY d.ui_order NULLS LAST,d.flag_key`, [plan.rows[0].id]
        )).rows;
      if (copiedCapabilities.length > 0) {
        await client.query(
          `INSERT INTO tenant_feature_flag_overrides(
             tenant_id,flag_key,enabled,updated_by_user_id
           )
           SELECT $1,entry.key,entry.enabled,$2
           FROM jsonb_to_recordset($3::jsonb) entry(key text,enabled boolean)
           ON CONFLICT(tenant_id,flag_key) DO UPDATE SET
             enabled=EXCLUDED.enabled,
             updated_by_user_id=EXCLUDED.updated_by_user_id,
             updated_at=now()`,
          [
            workspace.rows[0].id,
            root.userId,
            JSON.stringify(copiedCapabilities.map((capability) => ({
              key: capability.key,
              enabled: capability.enabled
            })))
          ]
        );
      }
      const operationGroup = randomUUID();
      await client.query(
        `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent,operation_group)
         VALUES($1,$2,'root','root.workspaces.create','workspace',$3,$4,$7,$8,$9),
               ($1,$2,'root','root.owner.invite','workspace_invitation',$5,$6,$7,$8,$9),
               ($1,$2,'root','capability.template.copy','capability_template',$10,$11,$7,$8,$9)`,
        [
          root.userId,
          workspace.rows[0].id,
          workspace.rows[0].id,
          { name: body.name, slug: workspace.rows[0].slug, planCode: plan.rows[0].code, capabilityTemplateTenantId: body.capabilityTemplateTenantId ?? null },
          invitation.rows[0].id,
          { email: body.ownerEmail },
          request.ip,
          typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null,
          operationGroup,
          body.capabilityTemplateTenantId,
          { source_tenant_id: body.capabilityTemplateTenantId,
            capabilities: copiedCapabilities.map((capability) => ({ key: capability.key, enabled: capability.enabled }))
          }
        ]
      );
      await client.query("COMMIT");
      inTransaction = false;
      let emailDelivery: { status: "sent" | "failed"; error?: string } = { status: "sent" };
      try {
        await sendWorkspaceInvitationEmail(emailProvider, {
          recipientEmail: body.ownerEmail.toLocaleLowerCase("en-US"),
          workspaceName: body.name,
          roleName: "OWNER",
          invitedByEmail: root.email,
          acceptUrl: buildInvitationAcceptUrl(config, token),
          expiresAt: new Date(invitation.rows[0].expires_at)
        });
      } catch (error) {
        emailDelivery = { status: "failed", error: "Workspace criado, mas o e-mail do owner não foi enviado. Verifique o SMTP e reenvie ou copie o link se ele estiver disponível." };
        app.log.error({ err: error, invitationId: invitation.rows[0].id, workspaceId: workspace.rows[0].id }, "Convite ROOT criado, mas falhou ao enviar e-mail");
      }
      return reply.status(201).send({
        workspace: { id: workspace.rows[0].id, slug: workspace.rows[0].slug, sessionId: session.rows[0].id },
        capabilities: copiedCapabilities.map((capability) => ({ key: capability.key, enabled: capability.enabled })),
        ownerInvitation: { id: invitation.rows[0].id, email: body.ownerEmail.toLocaleLowerCase("en-US"), expiresAt: invitation.rows[0].expires_at },
        token: shouldExposeInvitationToken(config, emailProvider) ? token : undefined,
        emailDelivery
      });
    } catch (error) {
      if (inTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.patch("/root/workspaces/:id", async (request) => {
    await requireRoot(request);
    const { id } = workspaceParams.parse(request.params);
    const body = workspaceUpdateBody.parse(request.body);
    const result = await db.query(
      `UPDATE tenants SET
         name=COALESCE($2,name),
         status=COALESCE($3,status),
         attendant_phone=CASE WHEN $4::boolean THEN $5 ELSE attendant_phone END,
         updated_at=now()
       WHERE id=$1
       RETURNING id,name,slug,status,attendant_phone,updated_at`,
      [id, body.name ?? null, body.status ?? null, body.attendantPhone !== undefined, body.attendantPhone ?? null]
    );
    if (!result.rows[0]) throw httpError(404, "Workspace não encontrado");
    await audit(request, { action: "root.workspaces.update", workspaceId: id, resourceType: "workspace", resourceId: id, metadata: body });
    return { workspace: result.rows[0] };
  });

  app.post("/root/workspaces/:id/access", { config: { rateLimit: HTTP_RATE_LIMITS.sensitiveWrite } }, async (request, reply) => {
    const root = await requireRoot(request);
    const { id } = workspaceParams.parse(request.params);
    const workspace = await db.query<{ id: string; name: string; slug: string; status: string }>(
      "SELECT id,name,COALESCE(slug,id::text) slug,status FROM tenants WHERE id=$1 AND status <> 'suspended'",
      [id]
    );
    if (!workspace.rows[0]) throw httpError(404, "Workspace não encontrado");

    const token = await createSessionToken({
      userId: root.userId,
      tenantId: id,
      email: root.email,
      role: "ROOT",
      isRoot: true,
      rootWorkspaceAccess: true
    });
    reply.setCookie("atendon_session", token, { httpOnly: true, sameSite: "lax", secure: config.NODE_ENV === "production", path: "/", maxAge: 43_200 });
    await db.query(
      `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
       VALUES($1,$2::uuid,'root','root.workspace.access','workspace',$2::text,$3,$4,$5)`,
      [
        root.userId,
        id,
        { name: workspace.rows[0].name, slug: workspace.rows[0].slug },
        request.ip,
        typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null
      ]
    );
    return buildMePayload({
      userId: root.userId,
      email: root.email,
      isRoot: true,
      tenantId: id,
      role: "ROOT",
      permissions: [],
      actorScope: "root",
      rootWorkspaceAccess: true
    });
  });

  app.delete("/root/workspaces/:id/contacts-and-messages", { config: { rateLimit: HTTP_RATE_LIMITS.sensitiveWrite } }, async (request) => {
    const root = await requireRoot(request);
    const { id } = workspaceParams.parse(request.params);
    const workspace = await db.query<{ id: string }>("SELECT id FROM tenants WHERE id=$1", [id]);
    if (!workspace.rows[0]) throw httpError(404, "Workspace não encontrado");

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const messages = await client.query<{ count: number }>(
        `SELECT count(*)::int count FROM messages m
         JOIN conversations c ON c.id=m.conversation_id
         WHERE c.tenant_id=$1`,
        [id]
      );
      await client.query(
        `UPDATE usage_logs SET conversation_id=NULL
         WHERE tenant_id=$1 AND conversation_id IN (SELECT id FROM conversations WHERE tenant_id=$1)`,
        [id]
      );
      const appointments = await client.query<{ id: string }>(
        "DELETE FROM scheduling_appointments WHERE tenant_id=$1 RETURNING id",
        [id]
      );
      const contacts = await client.query<{ id: string }>("DELETE FROM conversations WHERE tenant_id=$1 RETURNING id", [id]);
      const leads = await client.query<{ id: string }>(
        "DELETE FROM scheduling_leads WHERE tenant_id=$1 RETURNING id",
        [id]
      );
      const deleted = {
        contacts: contacts.rowCount ?? 0,
        messages: messages.rows[0]?.count ?? 0,
        leads: leads.rowCount ?? 0,
        appointments: appointments.rowCount ?? 0
      };
      await client.query(
        `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
         VALUES($1,$2,'root','root.dev.contacts_and_messages.delete','workspace',$3,$4,$5,$6)`,
        [
          root.userId,
          id,
          id,
          deleted,
          request.ip,
          typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null
        ]
      );
      await client.query("COMMIT");
      return { deleted };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/root/audit-logs", async (request) => {
    await requireRoot(request);
    const result = await db.query(
      `SELECT a.id,a.workspace_id,t.name workspace_name,a.actor_scope,a.action,a.resource_type,a.resource_id,
              a.metadata,a.ip_address,a.user_agent,a.created_at,u.email actor_email
       FROM audit_logs a
       LEFT JOIN users u ON u.id=a.actor_user_id
       LEFT JOIN tenants t ON t.id=a.workspace_id
       ORDER BY a.created_at DESC
       LIMIT 500`
    );
    return { auditLogs: result.rows };
  });

  app.get("/root/operations/metrics", async (request, reply) => {
    await requireRoot(request);
    reply.header("Cache-Control", "no-store");
    return collectOperationalSnapshot(db);
  });
}
