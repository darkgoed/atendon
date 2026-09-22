// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gauge, type Icon } from "@phosphor-icons/react";
import { CommandPalette, type PaletteItem } from "@/components/command-palette";
import { settingsNavGroups } from "@/lib/panel-manifest";

//chai puro + jest-dom/vitest: asserções por presença/atributos, nunca fetch real.

const { apiMock, pushMock } = vi.hoisted(() => ({ apiMock: vi.fn(), pushMock: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

const pageItems: PaletteItem[] = [
  { href: "/", label: "Visão geral", group: "Atendimento", Icon: Gauge as Icon }
];

const pageItem = { has_more: false, next_cursor: null };
const section = (items: Array<Record<string, unknown>>) => ({ items, page: pageItem });
const searchResponse = (sections: Record<string, unknown>) => ({
  q: "",
  page: { limit: 8, has_more: false, next_cursor: null },
  ...sections
});

type CapturedCall = { path: string; signal: AbortSignal | undefined };
const calls: CapturedCall[] = [];

function mockApiOnceWith(response: unknown) {
  apiMock.mockImplementation((path: unknown, init?: { signal?: AbortSignal }) => {
    calls.push({ path: String(path), signal: init?.signal });
    return Promise.resolve(response);
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderPalette(workspaceId?: string) {
  return render(
    <CommandPalette items={pageItems} open onOpenChange={vi.fn()} workspaceId={workspaceId} />
  );
}

function type(query: string) {
  fireEvent.change(screen.getByLabelText("Buscar"), { target: { value: query } });
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

function searchPaths() {
  return calls.map((call) => call.path);
}

beforeEach(() => {
  // jsdom não implementa scrollIntoView (usado no auto-scroll do palette)
  Element.prototype.scrollIntoView = vi.fn();
  apiMock.mockReset();
  pushMock.mockReset();
  calls.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("command-palette: debounce e mínimo de caracteres (GET /search)", () => {
  it("1 caractere nunca dispara requisição", async () => {
    mockApiOnceWith(searchResponse({}));
    renderPalette();
    type("a");
    await advance(1_000);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("debounce de 250ms: nada antes, exatamente após", async () => {
    mockApiOnceWith(searchResponse({}));
    renderPalette();
    type("ab");
    await advance(249);
    expect(apiMock).not.toHaveBeenCalled();
    await advance(1);
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(searchPaths()).toEqual(["/search?q=ab&limit=8"]);
  });

  it("digitar mais aciona a requisição nova e aborta a anterior", async () => {
    mockApiOnceWith(searchResponse({}));
    renderPalette();
    type("ab");
    await advance(250);
    type("abc");
    await settle();
    expect(calls[0]?.signal?.aborted).toBe(true);
    await advance(250);
    expect(searchPaths()).toEqual(["/search?q=ab&limit=8", "/search?q=abc&limit=8"]);
    expect(calls[1]?.signal?.aborted).toBe(false);
  });
});

describe("command-palette: cache por workspace", () => {
  it("resposta em cache não re-dispara; troca de workspace aborta em voo, limpa cache e re-busca", async () => {
    mockApiOnceWith(searchResponse({}));
    const view = renderPalette("w1");
    type("ab");
    await advance(250);
    await settle();
    expect(apiMock).toHaveBeenCalledTimes(1);

    type("ac");
    await advance(250);
    expect(apiMock).toHaveBeenCalledTimes(2);

    // troca de tenant: requisição "ac" em voo é abortada, cache de w1 é descartado
    view.rerender(
      <CommandPalette items={pageItems} open onOpenChange={vi.fn()} workspaceId="w2" />
    );
    await settle();
    expect(calls[1]?.signal?.aborted).toBe(true);

    // cache limpo: mesma query "ab" volta a bater na API (agora no tenant w2)
    type("ab");
    await advance(250);
    const abCalls = searchPaths().filter((path) => path === "/search?q=ab&limit=8");
    expect(abCalls).toHaveLength(2);
  });
});

describe("command-palette: seções do /search", () => {
  it("seção contacts omitida (sem permissão leads.follow_up.read) fica oculta; tarefas/conversas vazias também", async () => {
    mockApiOnceWith(
      searchResponse({
        tasks: section([]),
        conversations: section([{ id: "c1", contact_name: "Maria Souza" }])
      })
    );
    renderPalette();
    type("ab");
    await advance(250);
    await settle();
    expect(screen.getByText("Maria Souza")).toBeInTheDocument();
    // FE só itera as seções presentes: contacts omitido e tasks vazio → grupos ausentes
    expect(screen.queryByText("Contatos")).not.toBeInTheDocument();
    expect(screen.queryByText("Tarefas")).not.toBeInTheDocument();
    expect(screen.getByText("Conversas")).toBeInTheDocument();
  });
});

describe("command-palette: deep-links sem rota nova", () => {
  it("conversa → /conversas?id=, contato → /contatos, tarefa → /tarefas", async () => {
    mockApiOnceWith(
      searchResponse({
        contacts: section([{ id: "k1", name: "João Pereira", contact_phone: "+5511999990000" }]),
        tasks: section([{ id: "t1", title: "Ligar para o cliente" }]),
        conversations: section([{ id: "c1", contact_name: "Maria Souza" }])
      })
    );
    renderPalette();
    type("ab");
    await advance(250);
    await settle();

    fireEvent.click(screen.getByRole("option", { name: /Maria Souza/ }));
    expect(pushMock).toHaveBeenCalledWith("/conversas?id=c1");

    fireEvent.click(screen.getByRole("option", { name: /Ligar para o cliente/ }));
    expect(pushMock).toHaveBeenCalledWith("/tarefas");

    fireEvent.click(screen.getByRole("option", { name: /João Pereira/ }));
    expect(pushMock).toHaveBeenCalledWith("/contatos");
    expect(pushMock).toHaveBeenCalledTimes(3);
  });
});

describe("manifest de Configurações: 12 chaves, deep-link ?resource= e gating idêntico às abas", () => {
  function configuracoesSource(): string {
    const candidates = [
      resolve(process.cwd(), "app/configuracoes/page.tsx"),
      resolve(process.cwd(), "apps/panel/app/configuracoes/page.tsx")
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    expect(found, "app/configuracoes/page.tsx não encontrado a partir de process.cwd()").toBeTruthy();
    return readFileSync(found!, "utf8");
  }

  function extractMap(source: string, marker: string): Record<string, string> {
    const markerIndex = source.indexOf(marker);
    expect(markerIndex, `marcador ausente no source: ${marker}`).toBeGreaterThan(-1);
    const openBrace = source.indexOf("{", markerIndex);
    const closeBrace = source.indexOf("};", openBrace);
    const body = source.slice(openBrace + 1, closeBrace);
    const map: Record<string, string> = {};
    for (const [, , key, value] of body.matchAll(/("?)([A-Za-z-]+)\1:\s*([^\n]+?),?\s*\n/g)) {
      map[key] = value.trim().replace(/\s+/g, " ");
    }
    return map;
  }

  it("12 chaves; gating por chave do deep-link ?resource= é idêntico ao da aba; chaves vivem no settingsNavGroups", () => {
    const source = configuracoesSource();
    const tabVisible = extractMap(
      source,
      "const tabVisible: Partial<Record<Resource, boolean>> = {"
    );
    const deepLinkAccess = extractMap(
      source,
      "const access: Partial<Record<Resource, boolean>> = {"
    );

    const tabKeys = Object.keys(tabVisible).sort();
    expect(tabKeys).toEqual([
      "agenda-notifications",
      "armazenamento",
      "atendon-meet",
      "attendants",
      "categorias",
      "conversation-queues",
      "google-meet",
      "panel-notifications",
      "parceiros",
      "signature",
      "unidades",
      "workspace"
    ]);
    expect(tabKeys).toHaveLength(12);

    // deep-link cobre exatamente as 12 chaves de aba (nenhum destino "/...")
    for (const key of tabKeys) {
      expect(key.startsWith("/")).toBe(false);
    }
    expect(Object.keys(deepLinkAccess).sort()).toEqual(tabKeys);

    // mesma expressão de gating por chave (aba == deep-link)
    for (const key of tabKeys) {
      expect(deepLinkAccess[key], `gating divergente para ${key}`).toBe(tabVisible[key]);
    }

    // as 12 chaves estão na navegação única (settingsNavGroups), cada uma uma vez
    const groupKeys = settingsNavGroups.flatMap((group) => [...group.keys]);
    expect(settingsNavGroups).toHaveLength(9);
    for (const key of tabKeys) {
      expect(groupKeys.filter((groupKey) => groupKey === key)).toHaveLength(1);
    }
  });
});
