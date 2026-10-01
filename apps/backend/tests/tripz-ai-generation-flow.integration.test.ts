import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import Fastify from "fastify";
import pg from "pg";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { TripzAiRepository } from "../src/modules/tripz-ai/repository.js";
import { TripzAiTurnProcessor } from "../src/modules/tripz-ai/runtime.js";
import { TripzConversationOrchestrator } from "../src/modules/tripz-ai/ai/orchestrator.js";
import { parseTripzOpenRouterConfig, TripzOpenRouterClient } from "../src/modules/tripz-ai/ai/openrouter-client.js";
import { TripzDocumentService } from "../src/modules/tripz-ai/document/service.js";
import { registerTripzAiRoutes } from "../src/modules/tripz-ai/routes.js";
import { extractTripzPdfTextLocally } from "../src/modules/tripz-ai/pdf-text-extractor.js";
import type { TripzAccessScope } from "../src/modules/tripz-ai/domain.js";

// This test uses only synthetic facts and a disposable/local test database.
const target = new URL(config.DATABASE_URL);
if (!["127.0.0.1", "localhost"].includes(target.hostname) || ["5436", "6382"].includes(target.port) || !target.pathname.includes("test")) {
  throw new Error("Tripz generation regression requires a local, non-production test database");
}
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const repository = new TripzAiRepository(pool);
let scope: TripzAccessScope;
const facts = {
  client: { name: "Carlos" }, destination: "NYC", startDate: "2027-08-20", endDate: "2027-08-28", passengers: { adults: 2 },
  flights: [{ origin: "GRU", cabin: "Econômica" }],
  hotel: { name: "Hotel St. Regis", roomType: "Standard", checkIn: "2027-08-20", checkOut: "2027-08-28", totalRate: 10000, currency: "BRL" },
  pricing: { currency: "BRL", totalPrice: 10000 + 13000 * 2, pricePerPerson: (10000 + 13000 * 2) / 2, boardingTax: 0, notes: "Voos ida e volta: BRL 13000 por pessoa; hotel: BRL 10000 para o casal." },
  editorial: { commercial: { paymentSummary: "PIX à vista", paymentEntries: [{ label: "Pagamento", value: "PIX à vista" }] } }
};

beforeAll(async () => {
  const tenantId = (await pool.query("INSERT INTO tenants(name,status) VALUES('Tripz synthetic regression','active') RETURNING id")).rows[0].id;
  const userId = (await pool.query("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`tripz-generation-${randomUUID()}@test.local`])).rows[0].id;
  scope = { tenantId, userId, canManage: false };
});
afterAll(async () => {
  if (scope) {
    await pool.query("DELETE FROM tenants WHERE id=$1", [scope.tenantId]);
    await pool.query("DELETE FROM users WHERE id=$1", [scope.userId]);
  }
  await pool.end();
});

async function confirmedConversation() {
  const created = await repository.createConversation(scope, "Carlos");
  const fetcher = vi.fn(async () => Response.json({
    model: "synthetic/local", choices: [{ message: { content: JSON.stringify({
      assistantMessage: "Dados sintéticos salvos.", summary: "Carlos, NYC, valores e PIX salvos.", proposalPatch: facts,
      mediaUpdates: [], explicitCorrections: [], requestedAction: "none", missingInformation: [], issues: []
    }) } }], usage: { prompt_tokens: 100, completion_tokens: 25, cost: 0 }
  }));
  const client = new TripzOpenRouterClient(parseTripzOpenRouterConfig({ TRIPZ_AI_OPENROUTER_API_KEY: "synthetic-not-a-real-key", TRIPZ_AI_MODEL: "synthetic/local", TRIPZ_AI_ALLOWED_MODELS: "synthetic/local" }), { fetcher });
  const processor = new TripzAiTurnProcessor(repository, { authorizeScope: async (scope_) => scope_, createOrchestrator: () => new TripzConversationOrchestrator(client) });
  const conversationId = created.conversation.id;
  const turn = async (content: string) => {
    const user = await repository.createUserMessage(scope, { conversationId, content, attachmentIds: [], idempotencyKey: `tripz-${randomUUID()}` });
    await processor.process({ scope, conversationId, messageId: user.message.id, attachmentIds: [] });
    return (await repository.getConversationDetail(scope, conversationId))!;
  };
  await turn("Proposta para Carlos, NYC de 20/08/2027 a 28/08/2027, duas pessoas casal, GRU, econômica, sem preferência de companhia. Hotel St. Regis Standard, hotel BRL 10000 total casal, voos ida e volta BRL 13000 cada pessoa, taxa zero, BRL PIX à vista.");
  const reviewed = await turn("pode gerar!");
  expect(reviewed.proposal.state.status).toBe("ready_for_review");
  for (const fact of ["Carlos", "2027-08-20", "2027-08-28", "36000", "BRL", "PIX à vista", "10000", "13000"]) expect(reviewed.messages.at(-1)?.content).toContain(fact);
  const confirmed = await turn("confirmo");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(confirmed.proposal.schemaVersion).toBe(2);
  expect(confirmed.proposal.state.schemaVersion).toBe(2);
  expect(confirmed.proposal.state.reviewConfirmation?.confirmed).toBe(true);
  expect(confirmed.proposal.state.status).toBe("ready_for_pdf");
  expect(confirmed.proposal.state.client?.name).toBe("Carlos");
  expect(confirmed.proposal.state.pricing).toMatchObject(facts.pricing);
  expect(confirmed.proposal.state.editorial?.commercial?.paymentSummary).toBe("PIX à vista");
  expect(confirmed.proposal.state.flights[0].destination).toBeUndefined();
  return { ...confirmed, turn, fetcher };
}

describe("Tripz synthetic persisted generation", () => {
  it("invalidates content confirmation on editor changes and preserves partial editorial blocks", async () => {
    const confirmed = await confirmedConversation();
    const original = confirmed.proposal;
    const patched = await repository.patchProposal(scope, { conversationId: original.conversationId, expectedRevision: original.revision, patch: { editorial: { origin: "GRU" } } });
    expect(patched.state.reviewConfirmation).toBeUndefined();
    expect(patched.state.status).toBe("ready_for_review");
    expect(patched.state.editorial?.commercial?.paymentSummary).toBe("PIX à vista");
    expect((await repository.getProposal(scope, original.conversationId))?.schemaVersion).toBe(2);
  });

  it.runIf(process.env.TRIPZ_REAL_PDF === "1")("generates actual HTML and Chromium PDF through revision-checked endpoints and retries engine failure without another model call", async () => {
    const confirmed = await confirmedConversation();
    const service = new TripzDocumentService(repository);
    const app = Fastify();
    let failPdf = true;
    app.setErrorHandler((error, _request, reply) => reply.status((error as { statusCode?: number }).statusCode ?? 500).send({ message: (error as Error).message }));
    await registerTripzAiRoutes(app, {
      repository, authorize: async () => ({ ...scope, actorScope: "workspace", isRoot: false }), featureGate: async () => undefined,
      renderPreview: ({ scope, proposal }) => service.renderPreview(scope, proposal),
      renderPdf: async ({ scope, proposal }) => {
        if (failPdf) throw Object.assign(new Error("Motor PDF indisponível no teste"), { statusCode: 503 });
        return service.renderPdf(scope, proposal);
      }
    });
    try {
      const conversationId = confirmed.conversation.id;
      const expectedRevision = confirmed.proposal.revision;
      const pdfRequest = () => app.inject({ method: "POST", url: `/tripz-ai/conversations/${conversationId}/pdf`, payload: { expectedRevision } });
      expect((await pdfRequest()).statusCode).toBe(409);
      const preview = await app.inject({ method: "POST", url: `/tripz-ai/conversations/${conversationId}/preview`, payload: { expectedRevision } });
      expect(preview.statusCode, preview.body).toBe(201);
      const html = preview.json().html as string;
      for (const fact of ["Carlos", "36.000,00", "PIX à vista"]) expect(html).toContain(fact);
      expect(html).not.toContain("JFK");
      expect((await pdfRequest()).statusCode).toBe(503);
      expect((await repository.getProposal(scope, conversationId))?.state.status).toBe("ready_for_pdf");
      failPdf = false;
      const response = await pdfRequest();
      expect(response.statusCode, response.body).toBe(201);
      const downloaded = await app.inject({ url: response.json().downloadUrl });
      expect(downloaded.statusCode).toBe(200);
      const pdf = downloaded.rawPayload;
      const document = await PDFDocument.load(pdf);
      expect(pdf.length).toBeGreaterThan(1000);
      const pageCount = document.getPageCount();
      expect(pageCount).toBe((html.match(/data-page-id=/g) ?? []).length);
      expect(pageCount).toBeGreaterThan(0);
      const text = await extractTripzPdfTextLocally({ data: pdf, mimeType: "application/pdf", sizeBytes: pdf.length, metadata: { pageCountHint: pageCount } });
      for (const fact of ["Carlos", "36.000,00", "PIX à vista"]) expect(text).toContain(fact);
      expect(confirmed.fetcher).toHaveBeenCalledTimes(1);
      expect((await repository.getProposal(scope, conversationId))?.state.status).toBe("pdf_generated");
      if (process.env.TRIPZ_GENERATION_ARTIFACT_DIR) {
        const directory = process.env.TRIPZ_GENERATION_ARTIFACT_DIR;
        await mkdir(directory, { recursive: true });
        await writeFile(`${directory}/carlos-proposal.html`, html);
        await writeFile(`${directory}/carlos-proposal.pdf`, pdf);
        await writeFile(`${directory}/carlos-proposal.txt`, text ?? "");
        await writeFile(`${directory}/carlos-validation.json`, JSON.stringify({ pageCount, pdfBytes: pdf.length, proposalRevision: expectedRevision, schemaVersion: 2, client: "Carlos", totalPrice: 36000, currency: "BRL", payment: "PIX à vista", externalProviderCalls: 0 }, null, 2));
      }
    } finally {
      await app.close();
    }
  }, 60000);
});
