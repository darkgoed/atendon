import type { FastifyInstance } from "fastify";
import { requireWorkspace } from "../../auth/session.js";
import { searchQuerySchema, searchWorkspace } from "./service.js";

export async function registerSearchRoutes(app: FastifyInstance) {
  app.get("/search", async (request) => {
    // requireWorkspace — de propósito NÃO requirePermission: itens sem
    // permissão são OMITIDOS/esvaziados na resposta, nunca 403.
    const session = await requireWorkspace(request);
    const query = searchQuerySchema.parse(request.query ?? {});
    return searchWorkspace(session, query);
  });
}
