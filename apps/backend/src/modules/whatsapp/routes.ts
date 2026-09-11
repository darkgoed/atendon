import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "../../auth/session.js";
import { getLimit } from "../../billing/entitlements.js";
import { assertLimitWithinTransaction } from "../../billing/limits.js";
import { db } from "../../db/client.js";
import { withTenantTransaction } from "../../db/tenant-transaction.js";
import { MessageRepository } from "../messages/repository.js";
import type { WhatsAppSessionManager } from "./session-manager.js";
import { SessionRepository } from "./session-repository.js";

const connectionParams = z.object({ id: z.string().uuid() });
const createConnection = z.object({
  label: z.string().trim().min(1).max(60),
  channel: z.enum(["whatsapp", "instagram"]).default("whatsapp")
});
const updateConnection = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  is_primary: z.literal(true).optional()
}).refine((body) => body.label !== undefined || body.is_primary !== undefined, {
  message: "Informe o rótulo ou marque a conexão como principal"
});

type WhatsAppConnectionRoutesOptions = {
  whatsapp: Pick<WhatsAppSessionManager, "start" | "reconnect" | "logoutInstance" | "deleteInstance" | "sendText">;
};

function routeError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

export async function registerWhatsAppConnectionRoutes(
  app: FastifyInstance,
  options: WhatsAppConnectionRoutesOptions
): Promise<void> {
  const sessions = new SessionRepository(db);
  const messages = new MessageRepository(db);

  app.get("/connection/failed-messages", async (request) => {
    const session = await requirePermission(request, "connection.read");
    return { recovery: await messages.failedMessageRecoverySummary(session.tenantId) };
  });

  app.post("/connection/failed-messages/resend", async (request) => {
    const session = await requirePermission(request, "connection.manage");
    return messages.recoverFailedManualMessages(session.tenantId, ({ sessionId, destination, text }) =>
      options.whatsapp.sendText(sessionId, destination, text)
    );
  });

  app.get("/connections", async (request) => {
    const session = await requirePermission(request, "connection.read");
    const [connections, max] = await Promise.all([
      sessions.listByTenant(session.tenantId),
      getLimit(session.tenantId, "MAX_WHATSAPP_CONNECTIONS")
    ]);
    return {
      connections: connections.map((connection) => ({
        id: connection.id,
        label: connection.label,
        channel: connection.channel,
        is_primary: connection.isPrimary,
        status: connection.status,
        phone_number: connection.phoneNumber,
        qr_code: connection.qrCode,
        last_connected_at: connection.lastConnectedAt,
        disconnected_reason: connection.disconnectedReason,
        created_at: connection.createdAt
      })),
      limits: { used: connections.length, max }
    };
  });

  app.post("/connections", async (request, reply) => {
    const session = await requirePermission(request, "connection.manage");
    const body = createConnection.parse(request.body);
    if (body.channel === "instagram") {
      return reply.status(501).send({
        code: "CHANNEL_NOT_AVAILABLE",
        message: "Canal Instagram ainda não disponível para conexão"
      });
    }
    const created = await withTenantTransaction(db, session.tenantId, async (client) => {
      await assertLimitWithinTransaction(client, session.tenantId, "MAX_WHATSAPP_CONNECTIONS");
      const row = await client.query<{ id: string }>(
        `INSERT INTO whatsapp_sessions(tenant_id,label,is_primary,channel)
         SELECT $1,$2,NOT EXISTS(
           SELECT 1 FROM whatsapp_sessions
           WHERE tenant_id=$1 AND is_primary AND archived_at IS NULL
         ),$3
         RETURNING id`,
        [session.tenantId, body.label, body.channel]
      );
      return row.rows[0];
    });

    try {
      await options.whatsapp.start(created.id);
    } catch (error) {
      request.log.warn(
        { err: error, sessionId: created.id },
        "Instância Evolution não provisionou na criação"
      );
    }
    return reply.status(201).send({ connection: { id: created.id, label: body.label } });
  });

  app.post("/connections/:id/reconnect", async (request, reply) => {
    const session = await requirePermission(request, "connection.manage");
    const { id } = connectionParams.parse(request.params);
    const owned = await db.query<{ id: string }>(
      `SELECT id FROM whatsapp_sessions
       WHERE id=$2 AND tenant_id=$1 AND archived_at IS NULL`,
      [session.tenantId, id]
    );
    if (!owned.rows[0]) return reply.status(404).send({ error: "Conexão não encontrada" });
    await options.whatsapp.reconnect(id);
    return reply.status(202).send({ status: "qr_pending" });
  });

  app.patch("/connections/:id", async (request, reply) => {
    const session = await requirePermission(request, "connection.manage");
    const { id } = connectionParams.parse(request.params);
    const body = updateConnection.parse(request.body);
    const updated = await withTenantTransaction(db, session.tenantId, async (client) => {
      const target = await client.query<{ id: string }>(
        `SELECT id FROM whatsapp_sessions
         WHERE id=$2 AND tenant_id=$1 AND archived_at IS NULL
         FOR UPDATE`,
        [session.tenantId, id]
      );
      if (!target.rows[0]) return null;

      if (body.is_primary) {
        await client.query(
          `UPDATE whatsapp_sessions SET is_primary=false
           WHERE tenant_id=$1 AND is_primary AND archived_at IS NULL`,
          [session.tenantId]
        );
      }
      const row = await client.query<{ id: string; label: string; is_primary: boolean }>(
        `UPDATE whatsapp_sessions
         SET label=COALESCE($3,label), is_primary=COALESCE($4,is_primary)
         WHERE id=$2 AND tenant_id=$1 AND archived_at IS NULL
         RETURNING id,label,is_primary`,
        [session.tenantId, id, body.label ?? null, body.is_primary ?? null]
      );
      return row.rows[0] ?? null;
    });
    if (!updated) return reply.status(404).send({ error: "Conexão não encontrada" });
    return { connection: updated };
  });

  app.delete("/connections/:id", async (request, reply) => {
    const session = await requirePermission(request, "connection.manage");
    const { id } = connectionParams.parse(request.params);
    const archived = await withTenantTransaction(db, session.tenantId, async (client) => {
      await client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [session.tenantId]);
      const active = await client.query<{
        id: string;
        is_primary: boolean;
        instance_name: string;
      }>(
        `SELECT id,is_primary,instance_name FROM whatsapp_sessions
         WHERE tenant_id=$1 AND archived_at IS NULL
         ORDER BY is_primary DESC,created_at
         FOR UPDATE`,
        [session.tenantId]
      );
      const target = active.rows.find((connection) => connection.id === id);
      if (!target) throw routeError("Conexão não encontrada", 404);
      if (active.rows.length === 1) {
        throw routeError("Mantenha ao menos uma conexão de WhatsApp", 409);
      }
      if (target.is_primary) {
        throw routeError("Promova outra conexão a principal antes de remover esta", 409);
      }
      await client.query(
        `UPDATE whatsapp_sessions
         SET archived_at=now(),is_primary=false,status='disconnected'
         WHERE id=$2 AND tenant_id=$1`,
        [session.tenantId, id]
      );
      return target;
    });

    try {
      await options.whatsapp.logoutInstance(archived.instance_name);
    } catch (error) {
      request.log.warn(
        { err: error, sessionId: archived.id, instanceName: archived.instance_name },
        "Evolution logout falhou após arquivar conexão"
      );
    }
    try {
      await options.whatsapp.deleteInstance(archived.instance_name);
    } catch (error) {
      request.log.warn(
        { err: error, sessionId: archived.id, instanceName: archived.instance_name },
        "Evolution deleteInstance falhou após arquivar conexão"
      );
    }
    return reply.send({ ok: true });
  });
}
