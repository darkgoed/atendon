// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { api, permission } = vi.hoisted(() => ({ api: vi.fn(), permission: vi.fn() }));
vi.mock("../lib/api", () => ({ api }));
vi.mock("../lib/use-permission", () => ({ usePermission: permission }));

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

beforeEach(() => { cleanup(); api.mockReset(); permission.mockReturnValue(true); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }

  const initialLead = { id: "prefilled", telefone: "5511999994321", nome: "Ana" };
  function controlled(onInitiated = vi.fn(), onClose = vi.fn()) {
    const cache = new Map();
    const tree = (open: boolean) => (
      <SWRConfig value={{ provider: () => cache }}>
        <NewConversationDialog open={open} initialLead={initialLead} onClose={onClose} onInitiated={onInitiated} />
      </SWRConfig>
    );
    const view = render(tree(true));
    return { ...view, reopen: () => { view.rerender(tree(false)); view.rerender(tree(true)); } };
  }

  function fillContact() {
    fireEvent.click(screen.getByRole("button", { name: "Novo contato" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Telefone / WhatsApp" }), { target: { value: "11999991234" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Origem" }), { target: { value: "Indicação" } });
  }

  it("cria inline sem nome e inicia com o id retornado, preservando mensagem e conexão", async () => {
    const onInitiated = vi.fn();
    setup(onInitiated);
    const original = api.getMockImplementation()!;
    api.mockImplementation((path: string, init?: RequestInit) => path === "/scheduling/leads" && init?.method === "POST"
      ? Promise.resolve({ lead: { id: "created-id", telefone: "5511999991234" } }) : original(path, init));
    await vi.waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("conn-wa"));
    fireEvent.change(screen.getByRole("textbox", { name: /Primeira mensagem/ }), { target: { value: "Olá novo contato" } });
    fillContact();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Criar contato" }));
    expect(await screen.findByRole("status")).toHaveTextContent("5511999991234");
    const create = api.mock.calls.find(([path, init]) => path === "/scheduling/leads" && init?.method === "POST")!;
    expect(JSON.parse(create[1].body)).toEqual({ telefone: "11 99999-1234", origem: "Indicação" });
    expect(screen.getByRole("textbox", { name: /Primeira mensagem/ })).toHaveValue("Olá novo contato");
    fireEvent.click(screen.getByRole("button", { name: "Iniciar conversa" }));
    await vi.waitFor(() => expect(onInitiated).toHaveBeenCalledWith("conv-1"));
    const send = api.mock.calls.find(([path]) => path === "/conversations/initiate")!;
    expect(JSON.parse(send[1].body)).toEqual({ lead_id: "created-id", session_id: "conn-wa", text: "Olá novo contato" });
  });

  it("valida telefone/origem e retém todos os drafts quando cadastro falha", async () => {
    setup();
    const original = api.getMockImplementation()!;
    api.mockImplementation((path: string, init?: RequestInit) => path === "/scheduling/leads" && init?.method === "POST"
      ? Promise.reject(new Error("Cadastro recusado")) : original(path, init));
    fireEvent.change(screen.getByRole("textbox", { name: /Primeira mensagem/ }), { target: { value: "Mensagem guardada" } });
    fireEvent.click(screen.getByRole("button", { name: "Novo contato" }));
    const create = screen.getByRole("button", { name: "Criar contato" });
    fireEvent.change(screen.getByRole("textbox", { name: "Telefone / WhatsApp" }), { target: { value: "123" } });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Telefone / WhatsApp" }), { target: { value: "11999991234" } });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Origem" }), { target: { value: "Indicação" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Nome (opcional)" }), { target: { value: "Joana" } });
    fireEvent.click(create);
    expect(await screen.findByRole("alert")).toHaveTextContent("Cadastro recusado");
    expect(screen.getByRole("textbox", { name: "Nome (opcional)" })).toHaveValue("Joana");
    expect(screen.getByRole("textbox", { name: "Telefone / WhatsApp" })).toHaveValue("11 99999-1234");
    expect(screen.getByRole("textbox", { name: "Origem" })).toHaveValue("Indicação");
    expect(screen.getByRole("textbox", { name: /Primeira mensagem/ })).toHaveValue("Mensagem guardada");
  });

  it("sem leads.create não oferece nem faz cadastro", async () => {
    permission.mockReturnValue(false);
    setup();
    expect(permission).toHaveBeenCalledWith("leads.create");
    expect(screen.queryByRole("button", { name: "Novo contato" })).toBeNull();
    fireEvent.submit(screen.getByRole("textbox", { name: /Primeira mensagem/ }).closest("form")!);
    expect(api.mock.calls.some(([path, init]) => path === "/scheduling/leads" && init?.method === "POST")).toBe(false);
  });

  it("initialLead já está selecionado sem buscar e mudar busca remove o destinatário antigo", async () => {
    api.mockImplementation(async (path: string) => path === "/connections" ? connections : {});
    controlled();
    expect(screen.getByRole("status")).toHaveTextContent("Ana · 5511999994321");
    expect(api.mock.calls.some(([path]) => path.startsWith("/scheduling/leads"))).toBe(false);
    await vi.waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("conn-wa"));
    const message = screen.getByRole("textbox", { name: /Primeira mensagem/ });
    fireEvent.change(message, { target: { value: "Oi" } });
    expect(screen.getByRole("button", { name: "Iniciar conversa" })).not.toBeDisabled();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Outra" } });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Iniciar conversa" })).toBeDisabled();
    fireEvent.submit(message.closest("form")!);
    expect(api.mock.calls.some(([path]) => path === "/conversations/initiate")).toBe(false);
  });

  it("inicia diretamente com initialLead sem depender dos resultados da busca", async () => {
    api.mockImplementation(async (path: string) => path === "/connections" ? connections : { conversation_id: "prefilled-conversation" });
    const onInitiated = vi.fn();
    controlled(onInitiated);
    await vi.waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("conn-wa"));
    fireEvent.change(screen.getByRole("textbox", { name: /Primeira mensagem/ }), { target: { value: "Olá Ana" } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar conversa" }));
    await vi.waitFor(() => expect(onInitiated).toHaveBeenCalledWith("prefilled-conversation"));
    const send = api.mock.calls.find(([path]) => path === "/conversations/initiate")!;
    expect(JSON.parse(send[1].body)).toEqual({ lead_id: "prefilled", session_id: "conn-wa", text: "Olá Ana" });
    expect(api.mock.calls.some(([path]) => path.startsWith("/scheduling/leads"))).toBe(false);
  });

  it.each(["resolve", "reject"] as const)("trava cadastro duplicado e ignora %s tardio após fechar/reabrir", async (outcome) => {
    const pending = deferred<{ lead: typeof initialLead }>();
    api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/connections") return connections;
      if (path === "/scheduling/leads" && init?.method === "POST") return pending.promise;
      return {};
    });
    const onClose = vi.fn();
    const view = controlled(vi.fn(), onClose);
    fillContact();
    const form = screen.getByRole("textbox", { name: "Origem" }).closest("form")!;
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(api.mock.calls.filter(([path]) => path === "/scheduling/leads")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    view.reopen();
    await act(async () => {
      if (outcome === "resolve") pending.resolve({ lead: { ...initialLead, id: "stale", nome: "Antigo" } });
      else pending.reject(new Error("Erro antigo"));
    });
    expect(screen.getByRole("status")).toHaveTextContent("Ana");
    expect(screen.queryByText(/Antigo|Erro antigo/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["resolve", "reject"] as const)("trava envio duplicado e ignora %s tardio após fechar/reabrir", async (outcome) => {
    const pending = deferred<{ conversation_id: string }>();
    api.mockImplementation(async (path: string) => path === "/connections" ? connections : pending.promise);
    const onInitiated = vi.fn();
    const onClose = vi.fn();
    const view = controlled(onInitiated, onClose);
    await vi.waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("conn-wa"));
    const message = screen.getByRole("textbox", { name: /Primeira mensagem/ });
    fireEvent.change(message, { target: { value: "Primeira" } });
    act(() => { fireEvent.submit(message.closest("form")!); fireEvent.submit(message.closest("form")!); });
    expect(api.mock.calls.filter(([path]) => path === "/conversations/initiate")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    view.reopen();
    await act(async () => {
      if (outcome === "resolve") pending.resolve({ conversation_id: "stale-conversation" });
      else pending.reject(new Error("Envio antigo"));
    });
    expect(onInitiated).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("textbox", { name: /Primeira mensagem/ })).toHaveValue("");
  });

  it.each([
    ["create", false, "http"], ["create", true, "http"],
    ["send", false, "http"], ["send", true, "http"],
    ["search", false, "http"], ["search", true, "http"],
    ["create", false, "network"], ["create", true, "network"],
    ["send", false, "network"], ["send", true, "network"],
    ["search", false, "network"], ["search", true, "network"]
  ] as const)("api real: %s stale=%s falha %s fica no dialog vigente", async (mode, stale, failure) => {
    const { api: realApi } = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    const pending = deferred<Response>();
    const fetchMock = vi.fn((url: string) => url.endsWith("/connections")
      ? Promise.resolve(new Response(JSON.stringify(connections), { headers: { "content-type": "application/json" } }))
      : pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    api.mockImplementation(realApi);
    const onInitiated = vi.fn();
    const view = controlled(onInitiated);
    await vi.waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("conn-wa"));
    const events = vi.fn();
    window.addEventListener("atendon:error", events);
    try {
      if (mode === "create") {
        fillContact();
        fireEvent.click(screen.getByRole("button", { name: "Criar contato" }));
      } else if (mode === "send") {
        fireEvent.change(screen.getByRole("textbox", { name: /Primeira mensagem/ }), { target: { value: "Rascunho R1" } });
        fireEvent.click(screen.getByRole("button", { name: "Iniciar conversa" }));
      } else {
        fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Maria" } });
        await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.includes("busca=Maria"))).toBe(true));
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
      if (stale) {
        if (mode === "search") {
          fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Ana" } });
          fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ leads: [initialLead] }), { headers: { "content-type": "application/json" } })));
          await screen.findByRole("radio", { name: /Ana/ });
        } else view.reopen();
      }
      await act(async () => {
        if (failure === "network") pending.reject(new Error("Falha R1 dialog"));
        else pending.resolve(new Response(JSON.stringify({ error: "Falha R1 dialog" }), { status: 500, headers: { "content-type": "application/json" } }));
      });
      if (stale) expect(screen.queryByRole("alert")).toBeNull();
      else {
        expect(await screen.findByRole("alert")).toHaveTextContent(mode === "search" ? "Falha ao buscar contatos." : "Falha R1 dialog");
        if (mode === "send") expect(screen.getByRole("textbox", { name: /Primeira mensagem/ })).toHaveValue("Rascunho R1");
        if (mode === "create") expect(screen.getByRole("textbox", { name: "Origem" })).toHaveValue("Indicação");
      }
      expect(onInitiated).not.toHaveBeenCalled();
      expect(events).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("atendon:error", events);
    }
  });

  it("busca carregando não parece vazia e mantém Novo contato disponível", async () => {
    const pending = deferred<{ leads: [] }>();
    api.mockImplementation(async (path: string) => path === "/connections" ? connections : pending.promise);
    render(<SWRConfig value={{ provider: () => new Map() }}><NewConversationDialog open onClose={vi.fn()} onInitiated={vi.fn()} /></SWRConfig>);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Sem resultado" } });
    expect(screen.getByText("Buscando contatos…")).toBeInTheDocument();
    expect(screen.queryByText(/Nenhum contato/)).toBeNull();
    await vi.waitFor(() => expect(api.mock.calls.some(([path]) => path.startsWith("/scheduling/leads?"))).toBe(true));
    await act(async () => pending.resolve({ leads: [] }));
    expect(await screen.findByText("Nenhum contato encontrado.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Novo contato" })).not.toBeDisabled();
    expect(screen.queryByText(/Cadastre em Contatos/)).toBeNull();
  });
});
