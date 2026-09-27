import { hostname } from "node:os";
/**
 * Testes das rotas editoriais da Tripz (Wave B2):
 * brand settings (GET/PUT + leak guard), validate, finalize + versionamento
 * (409 re-sobrescrita, revert como nova versão) e media/from-url (SSRF guard).
 */
import { describe, expect, it, vi, afterEach, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.stubEnv("TRIPZ_PDF_DISABLE_CHROMIUM", "1");

const tenantId = randomUUID();
const conversationId = randomUUID();

function baseState(): TripzProposalState {
  return {
    schemaVersion: 2 as const,
    title: "Proposta O Porto",
    client: { name: "Jhonny e Shayene" },
    destination: "Porto, Portugal",
    startDate: "2026-05-20",
    endDate: "2026-05-24",
    passengers: { adults: 2 },
    flights: [],
    media: [],
    includedItems: [],
    itinerary: [],
    notes: [],
    generationRequirements: [],
    issueAcknowledgements: [],
    missingInformation: [],
    inconsistencies: [],
    status: "ready_for_pdf" as const
  };
}

interface FakeQueryRow {
  name?: string;
  config?: unknown;
}

class FakeBrandDatabase {
  public saved: unknown = null;
  public calls: Array<{ sql: string; values?: unknown[] }> = [];
  constructor(private readonly rows: FakeQueryRow[] = []) {}
  async query(sql: string, values?: unknown[]) {
    this.calls.push({ sql, values });
    if (/FROM tenants/i.test(sql)) return { rows: this.rows.filter((row) => row.name) };
    if (/INSERT INTO tripz_ai_brand_settings/i.test(sql)) {
      this.saved = values?.[2];
      return { rows: [] };
    }
    // SELECT ... FROM tripz_ai_brand_settings
    return { rows: [] };
  }
}

class FakeRepository {
  database = new FakeBrandDatabase([{ name: "Outra Turismo" }]);
  finalized = false;
  versions: Array<Record<string, unknown>> = [];
  revision = 7;
  state = baseState();
  savedVersionInput: Record<string, unknown> | null = null;
  attachments: Array<Record<string, unknown>> = [];

  async getProposal() {
    return {
      id: randomUUID(),
      conversationId,
      schemaVersion: 2,
      revision: this.revision,
      state: this.state,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  async patchProposal(_scope: unknown, input: { patch: Record<string, unknown> }) {
    this.state = { ...this.state, ...input.patch } as typeof this.state;
    this.revision += 1;
    return {
      id: randomUUID(),
      conversationId,
      schemaVersion: 2,
      revision: this.revision,
      state: this.state,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  async listProposalVersions() {
    return this.versions;
  }

  async saveProposalVersion(_scope: unknown, input: Record<string, unknown>) {
    this.savedVersionInput = input;
    const version = {
      id: randomUUID(),
      conversationId,
      proposalId: randomUUID(),
      versionNumber: this.versions.length + 1,
      ...(input.label ? { label: input.label } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      state: input.state,
      documentRevision: input.documentRevision,
      ...(input.approvedByUserId ? { approvedByUserId: input.approvedByUserId } : {}),
      createdAt: new Date().toISOString()
    };
    this.versions.unshift(version);
    return version;
  }

  async getLatestProposalVersion() {
    return this.versions[0] ?? null;
  }

  async createAttachment(_scope: unknown, input: { fileName: string; mimeType: string; data: Buffer }) {
    const attachment = { id: randomUUID(), fileName: input.fileName, mimeType: input.mimeType, sizeBytes: input.data.length };
    this.attachments.push(attachment);
    return { attachment, reused: false };
  }
}

import { createHash } from "node:crypto";
import Fastify from "fastify";
import { registerTripzAiRoutes } from "../src/modules/tripz-ai/routes.js";
import { OutboundDownloadTooLargeError } from "../src/security/outbound-url.js";
import type { TripzAccessScope, TripzProposalState } from "../src/modules/tripz-ai/domain.js";
import { NEUTRAL_PROPOSAL_BRAND } from "../../proposal-renderer/dist/index.js";

const scope: TripzAccessScope = { tenantId, userId: randomUUID(), canManage: true } as TripzAccessScope;

const apps: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllGlobals();
});

async function buildApp(repository: FakeRepository, downloadMedia?: Parameters<typeof registerTripzAiRoutes>[1] extends infer D ? D extends { downloadMedia?: infer F } ? F : never : never) {
  const app = Fastify();
  apps.push(app);
  app.setErrorHandler((error, _request, reply) => reply
    .status((error as { statusCode?: number }).statusCode ?? (error instanceof SyntaxError ? 400 : 500))
    .send({
      error: (error as { code?: string }).code ?? "ERRO",
      message: error instanceof Error ? error.message : "Erro interno"
    }));
  await registerTripzAiRoutes(app, {
    repository: repository as never,
    fileStore: { save: async () => "/dev/null", read: async () => Buffer.alloc(0), remove: async () => undefined } as never,
    authorize: async () => ({ ...scope, actorScope: "workspace", isRoot: false }),
    featureGate: async () => undefined,
    onMessageCreated: async () => undefined,
    ...(downloadMedia ? { downloadMedia } : {})
  });
  await app.ready();
  return app;
}

beforeAll(() => {
  // cache de brand por tenant — limpar entre testes não é exposto; usar tenantId único por suite
});

describe("brand settings", () => {
  it("GET retorna o brand neutro para tenant não-Tripz", async () => {
    const repository = new FakeRepository();
    const app = await buildApp(repository);
    const response = await app.inject({ method: "GET", url: "/tripz-ai/brand-settings" });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.config.tokens.primary).toBe(NEUTRAL_PROPOSAL_BRAND.tokens.primary);
    expect(body.config.tokens.primary).not.toBe("#123047");
  });

  it("PUT recusa o token primário Tripz em tenant não-Tripz (leak guard)", async () => {
    const repository = new FakeRepository();
    const app = await buildApp(repository);
    const response = await app.inject({
      method: "PUT",
      url: "/tripz-ai/brand-settings",
      payload: { config: { ...NEUTRAL_PROPOSAL_BRAND, tokens: { ...NEUTRAL_PROPOSAL_BRAND.tokens, primary: "#123047" } } }
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toBe("TRIPZ_IDENTITY_LEAK");
    expect(repository.database.saved).toBeNull();
  });
});

describe("validate + finalize + versions", () => {
  it("validate reporta inconsistências e canFinalize=false quando o estado está longe do PDF", async () => {
    const repository = new FakeRepository();
    repository.state = { ...baseState(), status: "collecting" as const, pricing: { currency: "BRL", totalPrice: 1000 } };
    const app = await buildApp(repository);
    const response = await app.inject({ method: "POST", url: `/tripz-ai/conversations/${conversationId}/validate` });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.canFinalize).toBe(false);
  });

  it("finalize cria a versão V1, marca finalized e recusa sobrescrita (409)", async () => {
    const repository = new FakeRepository();
    const app = await buildApp(repository);
    const first = await app.inject({
      method: "POST",
      url: `/tripz-ai/conversations/${conversationId}/finalize`,
      payload: { label: "Aprovada pelo casal" }
    });
    expect(first.statusCode).toBe(200);
    const body = JSON.parse(first.body);
    expect(body.version.versionNumber).toBe(1);
    expect(body.proposal.state.finalized).toBe(true);
    expect(repository.savedVersionInput?.label).toBe("Aprovada pelo casal");

    repository.state = { ...repository.state, finalized: true };
    const second = await app.inject({
      method: "POST",
      url: `/tripz-ai/conversations/${conversationId}/finalize`,
      payload: {}
    });
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).error).toBe("TRIPZ_ALREADY_FINALIZED");
  });

  it("finalize bloqueia inconsistências críticas", async () => {
    const repository = new FakeRepository();
    repository.state = {
      ...baseState(),
      startDate: "2026-13-40",
      endDate: "2026-99-99"
    };
    const app = await buildApp(repository);
    const response = await app.inject({ method: "POST", url: `/tripz-ai/conversations/${conversationId}/finalize`, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toBe("TRIPZ_CRITICAL_ISSUES");
  });

  it("revert cria uma NOVA versão com o estado antigo e restaura o estado atual", async () => {
    const repository = new FakeRepository();
    const app = await buildApp(repository);
    const snapshot = baseState();
    repository.versions.unshift({
      id: randomUUID(),
      conversationId,
      proposalId: randomUUID(),
      versionNumber: 1,
      label: "V1 original",
      state: snapshot,
      documentRevision: 3,
      createdAt: new Date().toISOString()
    });
    repository.state = { ...snapshot, title: "Editado depois", finalized: true };
    const response = await app.inject({
      method: "POST",
      url: `/tripz-ai/conversations/${conversationId}/versions`,
      payload: { versionId: (repository.versions[0] as { id: string }).id }
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.version.versionNumber).toBe(2);
    expect(body.version.label).toContain("Reversão");
    expect(body.proposal.state.title).toBe("Proposta O Porto");
    expect(body.proposal.state.finalized).toBe(false);
  });
});

describe("media from-url (SSRF guard)", () => {
  const post = (app: Awaited<ReturnType<typeof buildApp>>, payload: Record<string, unknown>) => app.inject({
    method: "POST",
    url: `/tripz-ai/conversations/${conversationId}/media/from-url`,
    payload
  });

  it("recusa http, hosts internos e NOMES que resolvem para IP interno (download real, pinado)", async () => {
    const repository = new FakeRepository();
    const app = await buildApp(repository);
    // os.hostname() resolve para IP do próprio container (privado/loopback):
    // o guard antigo só olhava o texto da URL e deixava passar.
    for (const url of [
      "http://169.254.169.254/latest/meta-data/", "https://localhost/img.png", "ftp://example.com/a.png",
      "https://10.0.0.1/a.png", `https://${hostname()}/loopback.png`, "http://images.example.com/a.png"
    ]) {
      const response = await post(app, { url });
      expect(response.statusCode, url).toBe(400);
    }
    expect(repository.attachments).toHaveLength(0);
  });

  it("não segue redirect (3xx vira falha) e corta imagem acima de 8 MB", async () => {
    const repository = new FakeRepository();
    const redirect = await buildApp(repository, vi.fn(async () => ({ status: 302, contentType: "", body: Buffer.alloc(0) })));
    expect((await post(redirect, { url: "https://images.example.com/a.png" })).json().error).toBe("TRIPZ_MEDIA_URL_FETCH");
    const huge = await buildApp(repository, vi.fn(async () => { throw new OutboundDownloadTooLargeError("big"); }));
    expect((await post(huge, { url: "https://images.example.com/a.png" })).statusCode).toBe(413);
    expect(repository.attachments).toHaveLength(0);
  });

  it("baixa imagem válida e cria attachment (mediaId = attachmentId)", async () => {
    const repository = new FakeRepository();
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const download = vi.fn(async () => ({ status: 200, contentType: "image/png", body: png }));
    const app = await buildApp(repository, download);
    const response = await post(app, { url: "https://images.example.com/porto-rio.jpg", category: "destination", label: "Rio Douro" });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.mediaId).toBe(body.attachmentId);
    expect(body.category).toBe("destination");
    expect(repository.attachments).toHaveLength(1);
    expect((repository.attachments[0] as { fileName: string }).fileName).toContain("Rio-Douro");
    expect(download).toHaveBeenCalledWith("https://images.example.com/porto-rio.jpg", expect.objectContaining({ maxBytes: 8 * 1024 * 1024 }));
  });

  it("recusa conteúdo não-imagem", async () => {
    const repository = new FakeRepository();
    const app = await buildApp(repository, vi.fn(async () => ({ status: 200, contentType: "text/html", body: Buffer.from("<html>") })));
    const response = await post(app, { url: "https://example.com/page" });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe("TRIPZ_MEDIA_URL_TYPE");
  });
});

void createHash;
