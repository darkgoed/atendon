// @vitest-environment jsdom

// UI do painel de Armazenamento (Configurações → Armazenamento; W2A R4).
// Mocks: @/lib/api roteado por path/método (o PATCH responde SEM per_origem,
// como o backend); SWRConfig com cache novo por render evita dedupe entre
// testes (o painel usa useSWR em /organization/storage).

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import { formatBytes, StorageSettingsPanel } from "@/components/storage-settings";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: mocks.api }));

const GI_B = 1024 ** 3;
type StorageFixture = {
  used_bytes: number;
  quota_bytes: number | null;
  retention_days: number | null;
  per_origem: { origem: string; bytes: number; itens: number }[];
};

const perOrigem = [
  { origem: "figurinhas_ia", bytes: 2048, itens: 2 },
  { origem: "logo_workspace", bytes: 5120, itens: 1 }
];
const usedBytes = 2048 + 5120;

// Quota pequena (10 KB) deixa as porcentagens das barras exatas (20% e 50%).
const smallQuotaFixture: StorageFixture = { used_bytes: usedBytes, quota_bytes: 10 * 1024, retention_days: 30, per_origem: perOrigem };
const defaultFixture: StorageFixture = { used_bytes: usedBytes, quota_bytes: 2 * GI_B, retention_days: 30, per_origem: perOrigem };

let currentStorage: StorageFixture;

function renderPanel(canManage = true, fixture: StorageFixture = defaultFixture) {
  currentStorage = fixture;
  return render(
    createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, createElement(StorageSettingsPanel, { canManage }))
  );
}

beforeEach(() => {
  mocks.api.mockReset();
  mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/organization/storage" && method === "GET") return { storage: currentStorage };
    if (path === "/organization/storage/settings" && method === "PATCH") {
      const body = JSON.parse(String(init?.body));
      return { storage: { used_bytes: currentStorage.used_bytes, quota_bytes: body.storage_quota_bytes, retention_days: body.retention_days } };
    }
    throw new Error(`URL inesperada: ${path} ${method}`);
  });
});

afterEach(cleanup);

describe("formatBytes", () => {
  it("formata bytes em pt-BR com 1 decimal abaixo de 10", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1,0 KB");
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(15 * 1024)).toBe("15 KB");
    expect(formatBytes(1024 * 1024)).toBe("1,0 MB");
    expect(formatBytes(1024 ** 4)).toBe("1,0 TB");
  });
});

describe("StorageSettingsPanel", () => {
  it("renderiza uma barra proporcional por origem e o resumo de uso", async () => {
    renderPanel(true, smallQuotaFixture);
    expect(await screen.findByText("Figurinhas da IA")).toBeInTheDocument();
    expect(screen.getByText("Logo do workspace")).toBeInTheDocument();
    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(2);
    expect(Number(bars[0].getAttribute("aria-valuenow"))).toBeCloseTo(20, 5);
    expect(Number(bars[1].getAttribute("aria-valuenow"))).toBeCloseTo(50, 5);
    expect(screen.getByText("7,0 KB")).toBeInTheDocument();
    expect(screen.getByText(/10 KB/)).toBeInTheDocument();
    expect(screen.getByText(/retenção de 30 dias/)).toBeInTheDocument();
  });

  it("salva via PATCH com quota em bytes e retention_days, preservando per_origem", async () => {
    const user = userEvent.setup();
    renderPanel();
    const quota = await screen.findByLabelText(/Quota \(GB\)/);
    expect(quota).toHaveValue(2);
    const retention = screen.getByLabelText(/Retenção \(dias\)/);
    expect(retention).toHaveValue(30);
    await user.clear(quota);
    await user.type(quota, "5");
    await user.clear(retention);
    await user.type(retention, "15");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("Armazenamento salvo.");
    const patchCall = mocks.api.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
    expect(patchCall?.[0]).toBe("/organization/storage/settings");
    expect(JSON.parse(String((patchCall?.[1] as RequestInit).body))).toEqual({
      storage_quota_bytes: 5 * GI_B,
      retention_days: 15
    });
    // A resposta do PATCH não traz per_origem: a lista continua na tela.
    expect(screen.getByText("Figurinhas da IA")).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
  });

  it("fica somente leitura sem permissão: inputs desabilitados e sem botão Salvar", async () => {
    renderPanel(false);
    expect(await screen.findByLabelText(/Quota \(GB\)/)).toBeDisabled();
    expect(screen.getByLabelText(/Retenção \(dias\)/)).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Salvar" })).toBeNull();
  });

  it("sem quota mostra 'ilimitado' sem barras e salva null para limpar", async () => {
    const user = userEvent.setup();
    renderPanel(true, { used_bytes: usedBytes, quota_bytes: null, retention_days: null, per_origem: perOrigem });
    expect((await screen.findAllByText(/ilimitado/)).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
    const quota = screen.getByLabelText(/Quota \(GB\)/);
    expect(quota).toHaveValue(null);
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("Armazenamento salvo.");
    const patchCall = mocks.api.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
    expect(JSON.parse(String((patchCall?.[1] as RequestInit).body))).toEqual({
      storage_quota_bytes: null,
      retention_days: null
    });
  });
});
