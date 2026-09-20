// Unit — SSRF residual no dispatcher de webhooks de fluxo (fix auditoria):
// host que resolve para IP interno é bloqueado ANTES do fetch (DNS
// rebinding/TOFU) e redirect 3xx não é seguido (destino sem o mesmo gate).
// node:dns é mockado (somente promises.lookup) e o db é falsificado: nenhum
// acesso a rede ou banco aqui.
import { beforeEach, describe, expect, it, vi } from "vitest";

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return { ...actual, promises: { ...actual.promises, lookup: lookupMock } };
});
vi.mock("../src/db/client.js", () => ({
  db: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }
}));

import { fireFlowWebhooks } from "../src/modules/qualification/service.js";
import { OutboundUrlError, publicHttpsFetch } from "../src/security/outbound-url.js";

const ctx = {
  tenantId: "00000000-0000-0000-0000-000000000000",
  qualificationId: "00000000-0000-0000-0000-000000000001",
  leadId: "00000000-0000-0000-0000-000000000002",
  flowId: "flow-ssrf-test",
  conversationId: null,
  sessionId: "00000000-0000-0000-0000-000000000003",
  contactPhone: "5511999999999",
  externalId: "ext-ssrf",
  timezone: null
};

const hook = { stepId: "W1", url: "https://public.example.com/hook", method: "POST" as const, body: null };

beforeEach(() => {
  lookupMock.mockReset();
  vi.unstubAllGlobals();
});

describe("fireFlowWebhooks — SSRF", () => {
  it("host que resolve para IP interno é bloqueado antes do fetch", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const results = await fireFlowWebhooks([hook], ctx);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("failed");
    expect(String(results[0].detail.erro)).toContain("IP interno");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("qualquer endereço resolvido em faixa interna bloqueia (rebinding com múltiplos A)", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 }
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const results = await fireFlowWebhooks([hook], ctx);

    expect(results[0].status).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redirect 3xx falha com motivo 'redirect' e não é seguido", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn(async () => ({ ok: false, status: 302 }));

    const results = await fireFlowWebhooks([hook], ctx, { fetchImpl: fetchMock });

    expect(results[0].status).toBe("failed");
    expect(results[0].detail.http_status).toBe(302);
    expect(results[0].detail.motivo).toBe("redirect");
    expect(fetchMock).toHaveBeenCalledTimes(1); // sem segundo fetch do destino
  });

  it("host público que resolve externo e responde 200 completa", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));

    const results = await fireFlowWebhooks([hook], ctx, { fetchImpl: fetchMock });

    expect(results[0].status).toBe("completed");
    expect(results[0].detail.http_status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetch padrão (publicHttpsFetch) revalida e nunca disca IP interno", async () => {
    lookupMock.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
    const error = await publicHttpsFetch(
      "https://public.example.com/hook",
      {},
      lookupMock as unknown as Parameters<typeof publicHttpsFetch>[2]
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutboundUrlError);
    expect((error as Error).message).toMatch(/publicly/i);
  });
});
