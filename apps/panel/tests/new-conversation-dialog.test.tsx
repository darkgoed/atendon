// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api }));

import { NewConversationDialog } from "../components/new-conversation-dialog";

const connections = {
  connections: [
    { id: "conn-wa", label: "Loja principal", channel: "whatsapp", status: "connected", phone_number: "5511999990000" },
    { id: "conn-wa-off", label: "Filial", channel: "whatsapp", status: "disconnected", phone_number: "5511888880000" },
    { id: "conn-ig", label: "Instagram", channel: "instagram", status: "connected" }
  ]
};

function setup(onInitiated = vi.fn(), onClose = vi.fn()) {
  api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/connections") return connections;
    if (path.startsWith("/scheduling/leads")) {
      return { leads: [{ id: "lead-1", telefone: "5511999991234", nome: "Maria" }] };
    }
    if (path === "/conversations/initiate") {
      expect((init as RequestInit).method).toBe("POST");
      return { conversation_id: "conv-1", lead_id: "lead-1", sent: true, duplicate: false };
    }
    return {};
  });
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <NewConversationDialog open onClose={onClose} onInitiated={onInitiated} />
    </SWRConfig>
  );
}

beforeEach(() => { cleanup(); api.mockReset(); });

describe("nova conversa dialog", () => {
  it("busca contatos, seleciona um, escolhe conexão conectada e inicia via /conversations/initiate", { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    const onInitiated = vi.fn();
    const onClose = vi.fn();
    setup(onInitiated, onClose);
    // Filial desconectada e Instagram não aparecem — só conexão WhatsApp conectada.
    const select = await screen.findByRole("combobox");
    await vi.waitFor(() => expect((select as HTMLSelectElement).options).toHaveLength(2));
    expect((select as HTMLSelectElement).options[1]?.textContent).toContain("Loja principal");
    const submit = screen.getByRole("button", { name: "Iniciar conversa" });
    expect(submit).toBeDisabled();
    const search = screen.getByPlaceholderText("Nome ou telefone");
    await user.type(search, "Mar");
    const hit = await screen.findByRole("radio", { name: /Maria/ }, { timeout: 5_000 });
    await user.click(hit);
    await user.selectOptions(select, "conn-wa");
    await user.type(screen.getByRole("textbox", { name: /Primeira mensagem/ }), "Olá! Aqui é a Ana da loja.");
    expect(submit).not.toBeDisabled();
    await user.click(submit);
    const call = api.mock.calls.find(([path]) => path === "/conversations/initiate");
    expect(call).toBeTruthy();
    const init = call![1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("idempotency-key")).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
    expect(JSON.parse(init.body as string)).toEqual({ lead_id: "lead-1", session_id: "conn-wa", text: "Olá! Aqui é a Ana da loja." });
    expect(onInitiated).toHaveBeenCalledWith("conv-1");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("busca curta mostra orientação; sem resultados mostra empty state", { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    setup();
    const search = screen.getByPlaceholderText("Nome ou telefone");
    await user.type(search, "M");
    expect(await screen.findByText(/Digite ao menos 2 caracteres/)).toBeInTheDocument();
    api.mockImplementation(async (path: string) => {
      if (path === "/connections") return connections;
      if (path.startsWith("/scheduling/leads")) return { leads: [] };
      return {};
    });
    await user.type(search, "a");
    expect(await screen.findByText(/Nenhum contato encontrado/, {}, { timeout: 5_000 })).toBeInTheDocument();
  });

  it("sem conexão WhatsApp conectada mostra estado vazio orientando conectar", { timeout: 30_000 }, async () => {
    api.mockImplementation(async (path: string) => {
      if (path === "/connections") return { connections: [{ id: "off", label: "Filial", channel: "whatsapp", status: "disconnected" }] };
      return {};
    });
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <NewConversationDialog open onClose={() => undefined} onInitiated={() => undefined} />
      </SWRConfig>
    );
    expect(await screen.findByText(/Nenhuma conexão WhatsApp conectada/)).toBeInTheDocument();
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select).toBeDisabled();
  });

  it("erro do backend (ex.: conexão caiu) aparece no dialog e mantém o rascunho", { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    setup();
    // Sobrescreve o mock do setup DEPOIS dele (o setup injeta sucesso).
    api.mockImplementation(async (path: string) => {
      if (path === "/connections") return connections;
      if (path.startsWith("/scheduling/leads")) return { leads: [{ id: "lead-1", telefone: "5511999991234", nome: "Maria" }] };
      if (path === "/conversations/initiate") return Promise.reject(new Error("A conexão do WhatsApp está desconectada"));
      return {};
    });
    const search = screen.getByPlaceholderText("Nome ou telefone");
    await user.type(search, "Mar");
    await user.click(await screen.findByRole("radio", { name: /Maria/ }, { timeout: 5_000 }));
    const select = screen.getByRole("combobox");
    await vi.waitFor(() => expect((select as HTMLSelectElement).options).toHaveLength(2));
    await user.selectOptions(select, "conn-wa");
    await vi.waitFor(() => expect((select as HTMLSelectElement).value).toBe("conn-wa"));
    const textarea = screen.getByRole("textbox", { name: /Primeira mensagem/ }) as HTMLTextAreaElement;
    await user.type(textarea, "Olá!");
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Iniciar conversa" })).not.toBeDisabled());
    // Submete o form diretamente: mesmo contrato do clique no botão submit,
    // sem a fragilidade de timing do jsdom com Radix + SWR revalidando.
    fireEvent.submit(textarea.closest("form")!);
    expect(await screen.findByRole("alert", {}, { timeout: 5_000 })).toHaveTextContent("A conexão do WhatsApp está desconectada");
    expect((screen.getByRole("textbox", { name: /Primeira mensagem/ }) as HTMLTextAreaElement).value).toBe("Olá!");
  });
});
