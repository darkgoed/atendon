import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireRootWorkspace } from "../../auth/session.js";
import { withTenantTransaction } from "../../db/tenant-transaction.js";
import { db } from "../../db/client.js";
import { hasStoredContent, recalculateStorageUsage, reserveStorageBytes } from "../organization/storage.js";
import { HTTP_RATE_LIMITS } from "../../security/http-rate-limit.js";
import { StickerRepository, decodeStickerBase64, stickerContentHash } from "./repository.js";

const idParams = z.object({ id: z.string().uuid() });
const createBody = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().min(3).max(500),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  fileName: z.string().trim().min(1).max(180),
  mimeType: z.literal("image/webp"),
  dataBase64: z.string().min(1).max(1_500_000)
});
const updateBody = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(500).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  enabled: z.boolean().optional()
}).refine((body) => Object.keys(body).length > 0, "Informe ao menos um campo");

async function audit(request: FastifyRequest, input: { action: string; resourceId: string; metadata?: Record<string, unknown> }) {
  const session = await requireRootWorkspace(request);
  await db.query(
    `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
     VALUES($1,$2,$3,$4,'ai_sticker',$5,$6,$7,$8)`,
    [session.userId, session.tenantId, session.actorScope, input.action, input.resourceId,
      input.metadata ?? {}, request.ip, request.headers["user-agent"] ?? null]
  );
}

export async function registerStickerRoutes(app: FastifyInstance) {
  const stickers = new StickerRepository(db);

  app.get("/ai-stickers", async (request) => {
    const session = await requireRootWorkspace(request);
    return { stickers: await stickers.list(session.tenantId) };
  });

  app.get("/ai-stickers/:id/content", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const { id } = idParams.parse(request.params);
    const content = await stickers.content(session.tenantId, id);
    if (!content) return reply.status(404).send({ error: "Figurinha não encontrada" });
    return reply.header("content-type", content.mimeType)
      .header("cache-control", "private, max-age=300")
      .header("x-content-type-options", "nosniff")
      .send(content.data);
  });

  app.post("/ai-stickers", {
    bodyLimit: 2 * 1024 * 1024,
    config: { rateLimit: HTTP_RATE_LIMITS.upload }
  }, async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const body = createBody.parse(request.body);
    const data = decodeStickerBase64(body.dataBase64);
    // R4: quota de armazenamento verificada ANTES de gravar (413 ao estourar)
    // e contador ajustado na MESMA transação do upload. Conteúdo idêntico
    // deduplica por (tenant_id,content_hash) e não consome quota.
    const sticker = await withTenantTransaction(db, session.tenantId, async (client) => {
      if (!await hasStoredContent(client, "ai_stickers", session.tenantId, stickerContentHash(data))) {
        await reserveStorageBytes(client, session.tenantId, data.length);
      }
      return new StickerRepository(client).createUpload({
        tenantId: session.tenantId,
        userId: session.userId,
        name: body.name,
        description: body.description,
        tags: [...new Set(body.tags.map((tag) => tag.toLocaleLowerCase("pt-BR")))],
        fileName: body.fileName,
        data
      });
    });
    await audit(request, { action: "agent.sticker.create", resourceId: sticker.id, metadata: { source: sticker.source } });
    return reply.status(201).send({ sticker });
  });

  app.patch("/ai-stickers/:id", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const { id } = idParams.parse(request.params);
    const body = updateBody.parse(request.body);
    const sticker = await stickers.update({
      tenantId: session.tenantId,
      id,
      ...body,
      ...(body.tags ? { tags: [...new Set(body.tags.map((tag) => tag.toLocaleLowerCase("pt-BR")))] } : {})
    });
    if (!sticker) return reply.status(404).send({ error: body.enabled ? "Descreva a figurinha antes de ativá-la" : "Figurinha não encontrada" });
    await audit(request, { action: "agent.sticker.update", resourceId: id, metadata: { enabled: sticker.enabled } });
    return { sticker };
  });

  app.delete("/ai-stickers/:id", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const { id } = idParams.parse(request.params);
    // R4: exclusão reconcilia o contador de uso na mesma transação.
    const removed = await withTenantTransaction(db, session.tenantId, async (client) => {
      const removed = await new StickerRepository(client).remove(session.tenantId, id);
      if (removed) await recalculateStorageUsage(session.tenantId, client);
      return removed;
    });
    if (!removed) return reply.status(404).send({ error: "Figurinha não encontrada" });
    await audit(request, { action: "agent.sticker.delete", resourceId: id });
    return reply.status(204).send();
  });
}
