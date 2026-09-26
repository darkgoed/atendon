// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Radix Popover/PopoverContent mede o balão com ResizeObserver, ausente no jsdom.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/use-permission", () => ({ usePermission: () => true }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

import Agent from "../app/agente/page";
import HumanizacaoPage from "../app/humanizacao/page";
import { InstagramConnections } from "../components/instagram-connections";

const agent = {
  system_prompt: "Atenda com cordialidade.",
  ai_model: "openai/gpt-4o-mini",
  openrouter_provider: null,
  model_params: { temperature: 0.4, max_tokens: 512, reasoning_effort: "medium" },
  is_active: false,
  has_openrouter_api_key: false,
  media_fallback_audio: "Recebi seu áudio.",
  media_fallback_image: "Recebi sua imagem.",
  media_fallback_document: "Recebi seu documento.",
  enabled_tools: ["registrar_lead"]
};

beforeEach(() => {
  apiMock.mockReset();
});
afterEach(() => cleanup());

describe("ajuda contextual — agente", () => {
  it("expõe HelpHint nas seções do formulário do agente", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/connections") return Promise.resolve({ connections: [] });
      if (path === "/agent") return Promise.resolve({ agent, available_tools: ["registrar_lead", "agendar_reuniao"], scope: "shared" });
      return Promise.reject(new Error(`rota inesperada ${path}`));
    });
    render(<Agent />);
    expect(await screen.findByRole("button", { name: "Ajuda: Ferramentas habilitadas" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ajuda: Parâmetros" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ajuda: Respostas para mídia" })).toBeInTheDocument();
  });

  // A página já dá retorno imediato na própria linha de status (sem flash extra).
  it("mostra “IA ativada” só no sucesso do ativar/desativar", async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string, options?: RequestInit) => {
      if (path === "/connections") return Promise.resolve({ connections: [] });
      if (path === "/agent/status" && options?.method === "PATCH") return Promise.resolve({ ok: true });
      if (path === "/agent") return Promise.resolve({ agent, available_tools: ["registrar_lead"], scope: "shared" });
      return Promise.reject(new Error(`rota inesperada ${path}`));
    });
    render(<Agent />);
    await user.click(await screen.findByRole("button", { name: "Ativar IA" }));
    expect(await screen.findByText("IA ativada")).toBeInTheDocument();

    cleanup();
    apiMock.mockImplementation((path: string, options?: RequestInit) => {
      if (path === "/connections") return Promise.resolve({ connections: [] });
      if (path === "/agent/status" && options?.method === "PATCH") return Promise.reject(new Error("Sessão instável"));
      if (path === "/agent") return Promise.resolve({ agent, available_tools: ["registrar_lead"], scope: "shared" });
      return Promise.reject(new Error(`rota inesperada ${path}`));
    });
    render(<Agent />);
    await user.click(await screen.findByRole("button", { name: "Ativar IA" }));
    expect(await screen.findByText("Sessão instável")).toBeInTheDocument();
    expect(screen.queryByText("IA ativada")).toBeNull();
  });
});

describe("ajuda contextual — humanização", () => {
  it("expõe HelpHint nos grupos de configuração", async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string) => {
      if (path === "/humanizer") {
        return Promise.resolve({ humanizer: { readDelay: { min: 350, max: 900 }, debounce: { initialWindowMs: 1600, silenceWindowMs: 1600, extensionMs: 500 } } });
      }
      return Promise.reject(new Error(`rota inesperada ${path}`));
    });
    render(<HumanizacaoPage />);
    await user.click(await screen.findByRole("button", { name: "Ajuda: Agrupamento de mensagens" }));
    expect(await screen.findByText("A IA espera o contato terminar de enviar mensagens em sequência antes de responder.")).toBeInTheDocument();
  });
});

describe("ajuda contextual — conexões do Instagram", () => {
  it("expõe HelpHint de estado, token e limite técnico", () => {
    render(
      <InstagramConnections
        status={{ configured: true, missing: [], graph_version: "v21.0", max_connections: 10 }}
        connections={[{
          id: "1",
          label: "Instagram Comercial",
          channel: "instagram",
          is_primary: false,
          phone_number: null,
          instagram_username: "minhaconta",
          instagram_account_id: "1789",
          token_expires_at: "2026-12-01T00:00:00.000Z",
          status: "connected",
          qr_code: null,
          last_connected_at: null,
          disconnected_reason: null,
          created_at: "2026-01-01T00:00:00.000Z"
        }]}
        canManage={false}
        onChanged={() => undefined}
      />
    );
    expect(screen.getByRole("button", { name: "Ajuda: Token expira em" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ajuda: estado da conta" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ajuda: limite técnico" })).toBeInTheDocument();
  });
});
