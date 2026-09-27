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
import { registerTripzAiRoutes, isPrivateHost } from "../src/modules/tripz-ai/routes.js";
import type { TripzAccessScope, TripzProposalState } from "../src/modules/tripz-ai/domain.js";
import { NEUTRAL_PROPOSAL_BRAND } from "../../proposal-renderer/dist/index.js";

const scope: TripzAccessScope = { tenantId, userId: randomUUID(), canManage: true } as TripzAccessScope;

const apps: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllGlobals();
});

async function buildApp(repository: FakeRepository) {
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
    onMessageCreated: async () => undefined
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
  it("bloqueia hosts privados, link-local e protocolos não-http", async () => {
    const repository = new FakeRepository();
    const app = await buildApp(repository);
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://localhost:5432/img.png", "ftp://example.com/a.png", "http://10.0.0.1/a.png"]) {
      const response = await app.inject({
        method: "POST",
        url: `/tripz-ai/conversations/${conversationId}/media/from-url`,
        payload: { url }
      });
      expect(response.statusCode).toBe(400);
    }
    expect(repository.attachments).toHaveLength(0);
  });

  it("baixa imagem válida e cria attachment (mediaId = attachmentId)", async () => {
    const repository = new FakeRepository();
    const app = await buildApp(repository);
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(png, {
      status: 200,
      headers: { "content-type": "image/png" }
    })));
    const response = await app.inject({
      method: "POST",
      url: `/tripz-ai/conversations/${conversationId}/media/from-url`,
      payload: { url: "https://images.example.com/porto-rio.jpg", category: "destination", label: "Rio Douro" }
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.mediaId).toBe(body.attachmentId);
    expect(body.category).toBe("destination");
    expect(repository.attachments).toHaveLength(1);
    expect((repository.attachments[0] as { fileName: string }).fileName).toContain("Rio-Douro");
    vi.unstubAllGlobals();
  });

  it("recusa conteúdo não-imagem", async () => {
    const repository = new FakeRepository();
    const app = await buildApp(repository);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", {
      status: 200,
      headers: { "content-type": "text/html" }
    })));
    const response = await app.inject({
      method: "POST",
      url: `/tripz-ai/conversations/${conversationId}/media/from-url`,
      payload: { url: "https://example.com/page" }
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe("TRIPZ_MEDIA_URL_TYPE");
    vi.unstubAllGlobals();
  });
});

describe("isPrivateHost", () => {
  it("classifica hosts perigosos", () => {
    expect(isPrivateHost("localhost", new URL("http://localhost/a"))).toBe(true);
    expect(isPrivateHost("169.254.169.254", new URL("http://169.254.169.254/"))).toBe(true);
    expect(isPrivateHost("172.16.0.1", new URL("http://172.16.0.1/"))).toBe(true);
    expect(isPrivateHost("10.1.2.3", new URL("http://10.1.2.3/"))).toBe(true);
    expect(isPrivateHost("user@evil.com", new URL("http://a:b@evil.com/"))).toBe(true);
    expect(isPrivateHost("images.example.com", new URL("https://images.example.com/a.jpg"))).toBe(false);
    expect(isPrivateHost("8.8.8.8", new URL("https://8.8.8.8/a.jpg"))).toBe(false);
  });
});

void createHash;
