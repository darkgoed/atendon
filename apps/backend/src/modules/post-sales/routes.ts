import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PermissionKey } from "../../auth/rbac.js";
import { requirePermission, type WorkspaceSession } from "../../auth/session.js";
import { db } from "../../db/client.js";
import { isFeatureFlagEnabled } from "../operations/feature-flags.js";
import {
  postSaleChecklistEntryParams,
  postSaleChecklistEntryUpdateSchema,
  postSaleClientCreateSchema,
  postSaleClientsQuerySchema,
  postSaleClientUpdateSchema,
  postSaleDebtsQuerySchema,
  postSaleIdParams,
  postSaleTemplateItemCreateSchema,
  postSaleTemplateItemParams,
  postSaleTemplateItemUpdateSchema,
  postSaleTemplateOrderSchema,
  postSaleVersionSchema
} from "./schemas.js";
import {
  createManualPostSaleClient,
  createPostSaleTemplateItem,
  getPostSaleClient,
  listPostSaleClients,
  listPostSaleDebtFilters,
  listPostSaleDebts,
  listPostSaleOptions,
  listPostSaleTemplate,
  reorderPostSaleTemplate,
  setPostSaleClientArchived,
  setPostSaleTemplateItemArchived,
  updatePostSaleChecklistEntry,
  updatePostSaleClient,
  updatePostSaleTemplateItem,
  type PostSaleActor
} from "./service.js";

function featureDisabled() {
  return Object.assign(new Error("Pós-venda temporariamente desabilitado"), {
    statusCode: 409,
    code: "FEATURE_FLAG_DISABLED",
    feature: "post_sales_v1"
  });
}

async function requirePostSales(request: FastifyRequest, permission: PermissionKey) {
  const session = await requirePermission(request, permission);
  if (!await isFeatureFlagEnabled(db, session.tenantId, "post_sales_v1")) throw featureDisabled();
  return session;
}

function actor(request: FastifyRequest, session: WorkspaceSession): PostSaleActor {
  return {
    userId: session.userId,
    actorScope: session.actorScope,
    ipAddress: request.ip,
    userAgent: typeof request.headers["user-agent"] === "string"
      ? request.headers["user-agent"]
      : undefined
  };
}

function canReadConversations(session: WorkspaceSession) {
  return Boolean(session.isRoot && session.rootWorkspaceAccess)
    || session.permissions.includes("conversations.read");
}

export async function registerPostSalesRoutes(app: FastifyInstance) {
  app.get("/post-sales/clients", async (request) => {
    const session = await requirePostSales(request, "post_sales.use");
    return listPostSaleClients(session.tenantId, postSaleClientsQuerySchema.parse(request.query));
  });

  app.post("/post-sales/clients", async (request, reply) => {
    const session = await requirePostSales(request, "post_sales.use");
    const client = await createManualPostSaleClient(
      session.tenantId,
      actor(request, session),
      postSaleClientCreateSchema.parse(request.body)
    );
    return reply.status(201).send({ client });
  });

  app.get("/post-sales/clients/:id", async (request) => {
    const session = await requirePostSales(request, "post_sales.use");
    const { id } = postSaleIdParams.parse(request.params);
    return getPostSaleClient(session.tenantId, id, canReadConversations(session));
  });

  app.patch("/post-sales/clients/:id", async (request) => {
    const session = await requirePostSales(request, "post_sales.use");
    const { id } = postSaleIdParams.parse(request.params);
    return {
      client: await updatePostSaleClient(
        session.tenantId,
        id,
        actor(request, session),
        postSaleClientUpdateSchema.parse(request.body)
      )
    };
  });

  app.post("/post-sales/clients/:id/archive", async (request) => {
    const session = await requirePostSales(request, "post_sales.use");
    const { id } = postSaleIdParams.parse(request.params);
    const { version } = postSaleVersionSchema.parse(request.body);
    return { client: await setPostSaleClientArchived(session.tenantId, id, actor(request, session), version, true) };
  });

  app.post("/post-sales/clients/:id/restore", async (request) => {
    const session = await requirePostSales(request, "post_sales.use");
    const { id } = postSaleIdParams.parse(request.params);
    const { version } = postSaleVersionSchema.parse(request.body);
    return { client: await setPostSaleClientArchived(session.tenantId, id, actor(request, session), version, false) };
  });

  app.patch("/post-sales/clients/:clientId/checklist/:entryId", async (request) => {
    const session = await requirePostSales(request, "post_sales.use");
    const { clientId, entryId } = postSaleChecklistEntryParams.parse(request.params);
    return {
      entry: await updatePostSaleChecklistEntry(
        session.tenantId,
        clientId,
        entryId,
        actor(request, session),
        postSaleChecklistEntryUpdateSchema.parse(request.body)
      )
    };
  });

  app.get("/post-sales/debts", async (request) => {
    const session = await requirePostSales(request, "post_sales.use");
    return listPostSaleDebts(session.tenantId, postSaleDebtsQuerySchema.parse(request.query));
  });

  app.get("/post-sales/debts/options", async (request) => {
    const session = await requirePostSales(request, "post_sales.use");
    return listPostSaleDebtFilters(session.tenantId);
  });

  app.get("/post-sales/options", async (request) => {
    const session = await requirePostSales(request, "post_sales.use");
    return listPostSaleOptions(session.tenantId);
  });

  app.get("/post-sales/checklist-template/items", async (request) => {
    const session = await requirePostSales(request, "post_sales.manage");
    return listPostSaleTemplate(session.tenantId);
  });

  app.post("/post-sales/checklist-template/items", async (request, reply) => {
    const session = await requirePostSales(request, "post_sales.manage");
    const { description } = postSaleTemplateItemCreateSchema.parse(request.body);
    const item = await createPostSaleTemplateItem(session.tenantId, actor(request, session), description);
    return reply.status(201).send({ item });
  });

  app.patch("/post-sales/checklist-template/items/:id", async (request) => {
    const session = await requirePostSales(request, "post_sales.manage");
    const { id } = postSaleTemplateItemParams.parse(request.params);
    const body = postSaleTemplateItemUpdateSchema.parse(request.body);
    return {
      item: await updatePostSaleTemplateItem(
        session.tenantId,
        id,
        actor(request, session),
        body.version,
        body.description
      )
    };
  });

  app.put("/post-sales/checklist-template/order", async (request) => {
    const session = await requirePostSales(request, "post_sales.manage");
    return reorderPostSaleTemplate(
      session.tenantId,
      actor(request, session),
      postSaleTemplateOrderSchema.parse(request.body)
    );
  });

  app.post("/post-sales/checklist-template/items/:id/archive", async (request) => {
    const session = await requirePostSales(request, "post_sales.manage");
    const { id } = postSaleTemplateItemParams.parse(request.params);
    const { version } = postSaleVersionSchema.parse(request.body);
    return {
      item: await setPostSaleTemplateItemArchived(session.tenantId, id, actor(request, session), version, true)
    };
  });

  app.post("/post-sales/checklist-template/items/:id/restore", async (request) => {
    const session = await requirePostSales(request, "post_sales.manage");
    const { id } = postSaleTemplateItemParams.parse(request.params);
    const { version } = postSaleVersionSchema.parse(request.body);
    return {
      item: await setPostSaleTemplateItemArchived(session.tenantId, id, actor(request, session), version, false)
    };
  });
}
