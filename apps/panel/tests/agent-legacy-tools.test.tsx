// @vitest-environment jsdom
// R4 (specs/active/comments-20260924-ai-conversas.md): o GET /agent pode trazer em
// enabled_tools um nome legado que não está mais em available_tools. A tela avisa,
// preserva a seleção válida e manda no PUT só nomes conhecidos; o mock do PUT
// replica a validação estrita do backend (agentSchema rejeita nome desconhecido).
// O mesmo vale por número (GET /agent?session_id=<uuid>, PUT com sessionId): trocar de alvo
// não leva formulário, legado nem aviso de sucesso de uma configuração para a outra.
import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/use-permission", () => ({ usePermission: () => true }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

import Agent from "../app/agente/page";

const AVAILABLE = ["registrar_lead", "agendar_reuniao"];

const agent = {
  system_prompt: "Atenda com cordialidade.",
  ai_model: "openai/gpt-4o-mini",
  openrouter_provider: null,
  model_params: { temperature: 0.4, max_tokens: 512, reasoning_effort: "medium" },
  is_active: true,
  has_openrouter_api_key: false,
  media_fallback_audio: "Recebi seu áudio.",
  media_fallback_image: "Recebi sua imagem.",
  media_fallback_document: "Recebi seu documento.",
  enabled_tools: ["registrar_lead", "ferramenta_obsoleta"]
};

// Com mais de uma conexão a tela mostra o seletor de alvo (compartilhado ou um número).
const SESSION = "6f1d2c3b-4a5e-4f60-9b7a-8c9d0e1f2a3b";
const CONNECTIONS = [
  { id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", label: "Comercial", is_primary: true },
  { id: SESSION, label: "Suporte", is_primary: false }
];
const NUMBER_PROMPT = "Atenda o suporte técnico.";

type PutBody = { enabledTools: string[]; systemPrompt: string; sessionId: string | null };

function mockBackend(put: (body: { enabledTools?: string[] }) => Promise<unknown>) {
  apiMock.mockImplementation((path: string, options?: RequestInit) => {
    if (path === "/connections") return Promise.resolve({ connections: [] });
    if (path === "/agent" && options?.method === "PUT") return put(JSON.parse(String(options.body)));
    if (path === "/agent") return Promise.resolve({ agent, available_tools: AVAILABLE, scope: "shared" });
    return Promise.reject(new Error(`rota inesperada ${path}`));
  });
}

// Compartilhada e exclusiva do número SESSION, cada uma com o próprio nome legado (sem a
// exclusiva, o número herda a compartilhada). O PUT aceito grava só a do sessionId enviado;
// `numberReady` segura a resposta do GET do número.
function mockPerNumber(put: (body: PutBody) => Promise<unknown> = strictPut, numberReady: Promise<unknown> = Promise.resolve()) {
  const configs: { shared: typeof agent; number?: typeof agent } = {
    shared: agent,
    number: { ...agent, system_prompt: NUMBER_PROMPT, enabled_tools: ["agendar_reuniao", "ferramenta_antiga_suporte"] }
  };
  apiMock.mockImplementation((path: string, options?: RequestInit) => {
    if (path === "/connections") return Promise.resolve({ connections: CONNECTIONS });
    if (path === "/agent" && options?.method === "PUT") {
      const body = JSON.parse(String(options.body)) as PutBody;
      return put(body).then((result) => {
        const saved = { ...agent, system_prompt: body.systemPrompt, enabled_tools: body.enabledTools };
        if (body.sessionId === SESSION) configs.number = saved;
        else configs.shared = saved;
        return result;
      });
    }
    if (path === "/agent") return Promise.resolve({ agent: configs.shared, available_tools: AVAILABLE, scope: "shared" });
    if (path === `/agent?session_id=${SESSION}`) {
      return numberReady.then(() => ({ agent: configs.number ?? configs.shared, available_tools: AVAILABLE, scope: configs.number ? "connection" : "shared" }));
    }
    return Promise.reject(new Error(`rota inesperada ${path}`));
  });
  return configs;
}

function strictPut(body: { enabledTools?: string[] }) {
  return body.enabledTools?.every((name) => AVAILABLE.includes(name))
    ? Promise.resolve({ ok: true })
    : Promise.reject(new Error("Há uma ferramenta desconhecida"));
}

async function editAndSave() {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Instruções do agente"), " Seja breve.");
  await user.click(screen.getByRole("button", { name: "Salvar alterações" }));
}

function putBodies() {
  return apiMock.mock.calls
    .filter(([path, options]) => path === "/agent" && (options as RequestInit | undefined)?.method === "PUT")
    .map(([, options]) => JSON.parse(String((options as RequestInit).body)) as PutBody);
}

// Troca o alvo e espera o formulário dele (reconhecido pelo prompt).
async function switchTo(user: ReturnType<typeof userEvent.setup>, value: string, prompt: string) {
  await user.selectOptions(screen.getByLabelText("Número que usa este prompt"), value);
  expect(await screen.findByDisplayValue(prompt)).toBeInTheDocument();
}

// Corpo em bloco: devolver a mock faria o vitest registrá-la como cleanup hook.
beforeEach(() => {
  apiMock.mockReset();
});
afterEach(() => cleanup());

describe("agente — ferramentas legadas (R4)", () => {
  it("avisa explicitamente sobre o nome obsoleto e mantém a seleção válida", async () => {
    mockBackend(strictPut);
    render(<Agent />);

    await screen.findByLabelText("Instruções do agente");
    expect(screen.getByRole("alert")).toHaveTextContent("ferramenta_obsoleta");
    expect(screen.getByRole("checkbox", { name: "registrar_lead" })).toBeChecked();
    // A limpeza pode ser salva direto, sem edição artificial.
    expect(screen.getByRole("button", { name: "Salvar alterações" })).toBeEnabled();
  });

  it("salva enviando só nomes conhecidos, sem erro de ferramenta desconhecida", async () => {
    mockBackend(strictPut);
    render(<Agent />);

    await editAndSave();

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0].enabledTools).toEqual(["registrar_lead"]);
    expect(putBodies()[0].systemPrompt).toBe("Atenda com cordialidade. Seja breve.");
    expect(await screen.findByText("Alterações salvas.")).toBeInTheDocument();
    expect(screen.queryByText("Há uma ferramenta desconhecida")).toBeNull();
    expect(screen.queryByText(/ferramenta_obsoleta/)).toBeNull();
    expect(screen.getByRole("checkbox", { name: "registrar_lead" })).toBeChecked();
  });

  it("não anuncia sucesso quando o PUT falha", async () => {
    mockBackend(() => Promise.reject(new Error("Falha temporária no servidor")));
    render(<Agent />);

    await editAndSave();

    expect(await screen.findByText("Falha temporária no servidor")).toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.queryByText("Agente salvo")).toBeNull();
    expect(screen.queryByText("Salvo")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Salvar alterações" })).toBeEnabled());
  });

  it("troca entre o compartilhado e o número, cada um com seu legado, e salva só o número", async () => {
    mockPerNumber();
    const user = userEvent.setup();
    render(<Agent />);

    expect(await screen.findByDisplayValue(agent.system_prompt)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("ferramenta_obsoleta");

    await switchTo(user, SESSION, NUMBER_PROMPT);
    expect(screen.getByRole("alert")).toHaveTextContent("ferramenta_antiga_suporte");
    expect(screen.getByRole("alert")).not.toHaveTextContent("ferramenta_obsoleta");
    expect(screen.getByRole("checkbox", { name: "agendar_reuniao" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "registrar_lead" })).not.toBeChecked();

    await user.click(screen.getByRole("button", { name: "Salvar alterações" }));
    expect(await screen.findByText("Alterações salvas.")).toBeInTheDocument();
    expect(putBodies()).toEqual([expect.objectContaining({ sessionId: SESSION, systemPrompt: NUMBER_PROMPT, enabledTools: ["agendar_reuniao"] })]);
    expect(screen.queryByRole("alert")).toBeNull();

    // O compartilhado segue intocado, com o próprio legado pendente, e não herda o "salvo" do número.
    await switchTo(user, "", agent.system_prompt);
    expect(screen.getByRole("alert")).toHaveTextContent("ferramenta_obsoleta");
    expect(screen.getByRole("checkbox", { name: "registrar_lead" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "agendar_reuniao" })).not.toBeChecked();
    expect(screen.queryByText("Alterações salvas.")).toBeNull();

    // Relido, o número volta só com a seleção válida que foi salva.
    await switchTo(user, SESSION, NUMBER_PROMPT);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "agendar_reuniao" })).toBeChecked();
    expect(putBodies()).toHaveLength(1);
  });

  it("o \"salvo\" do compartilhado não passa para o número aberto logo depois", async () => {
    mockPerNumber();
    const user = userEvent.setup();
    render(<Agent />);

    await editAndSave();
    expect(await screen.findByText("Agente salvo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salvo" })).toBeDisabled();

    // Ainda dentro do tempo do selo: o número tem o próprio legado pendente e nada foi salvo nele.
    await switchTo(user, SESSION, NUMBER_PROMPT);
    expect(screen.getByRole("alert")).toHaveTextContent("ferramenta_antiga_suporte");
    expect(screen.queryByText("Agente salvo")).toBeNull();
    expect(screen.queryByRole("button", { name: "Salvo" })).toBeNull();
    expect(screen.getByRole("button", { name: "Salvar alterações" })).toBeEnabled();
  });

  it("configuração de outro alvo, ainda carregando ou atrasada, não vai ao formulário nem ao PUT", async () => {
    let releaseNumber: (value: unknown) => void = () => undefined;
    mockPerNumber(strictPut, new Promise((resolve) => { releaseNumber = resolve; }));
    const user = userEvent.setup();
    render(<Agent />);
    expect(await screen.findByDisplayValue(agent.system_prompt)).toBeInTheDocument();

    // Enquanto o número carrega, o formulário do compartilhado (com legado a limpar) não pode ser salvo nele.
    await user.selectOptions(screen.getByLabelText("Número que usa este prompt"), SESSION);
    expect(screen.getByRole("button", { name: "Salvar alterações" })).toBeDisabled();

    // Volta ao compartilhado antes da resposta do número, que chega depois e deve ser descartada.
    await switchTo(user, "", agent.system_prompt);
    await act(async () => {
      releaseNumber(undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByLabelText("Instruções do agente")).toHaveValue(agent.system_prompt);
    expect(screen.getByRole("alert")).toHaveTextContent("ferramenta_obsoleta");
    expect(screen.getByRole("alert")).not.toHaveTextContent("ferramenta_antiga_suporte");

    await user.click(screen.getByRole("button", { name: "Salvar alterações" }));
    expect(await screen.findByText("Alterações salvas.")).toBeInTheDocument();
    expect(putBodies()).toEqual([expect.objectContaining({ sessionId: null, systemPrompt: agent.system_prompt, enabledTools: ["registrar_lead"] })]);
  });

  it("falha no PUT do número não anuncia sucesso nem o dá como prompt exclusivo", async () => {
    const configs = mockPerNumber(() => Promise.reject(new Error("Falha temporária no servidor")));
    delete configs.number; // ainda sem prompt exclusivo: o número herda o compartilhado, com o legado
    const user = userEvent.setup();
    render(<Agent />);
    expect(await screen.findByDisplayValue(agent.system_prompt)).toBeInTheDocument();

    await switchTo(user, SESSION, agent.system_prompt);
    expect(screen.getByText(/Mostrando o prompt compartilhado/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Salvar alterações" }));

    expect(await screen.findByText("Falha temporária no servidor")).toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(putBodies()).toEqual([expect.objectContaining({ sessionId: SESSION, enabledTools: ["registrar_lead"] })]);
    expect(screen.queryByText("Alterações salvas.")).toBeNull();
    expect(screen.queryByText("Agente salvo")).toBeNull();
    // Nada foi gravado: o número segue no compartilhado e o aviso do legado permanece.
    expect(screen.getByText(/Mostrando o prompt compartilhado/)).toBeInTheDocument();
    expect(screen.queryByText(/Este número tem um prompt exclusivo/)).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("ferramenta_obsoleta");
    await waitFor(() => expect(screen.getByRole("button", { name: "Salvar alterações" })).toBeEnabled());
  });
});

// Save em voo: a resposta do PUT vale só para o rascunho e o alvo do clique. `deferred` segura o PUT.
function deferred() {
  let resolve: (value: unknown) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// Libera a resposta pendente e deixa a página reagir a ela.
async function settle(release: () => void) {
  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("agente — save em voo", () => {
  it("controle: sem edição em voo, o PUT aceito confirma e limpa o dirty", async () => {
    const put = deferred();
    mockBackend(() => put.promise);
    render(<Agent />);

    await editAndSave();
    expect(screen.getByRole("button", { name: "Salvando…" })).toBeDisabled();
    await settle(() => put.resolve({ ok: true }));

    expect(screen.getByLabelText("Instruções do agente")).toHaveValue("Atenda com cordialidade. Seja breve.");
    expect(screen.getByText("Alterações salvas.")).toBeInTheDocument();
    expect(screen.getByText("Agente salvo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salvo" })).toBeDisabled();
  });

  it("edição feita com o PUT em voo não é sobrescrita nem dada como salva", async () => {
    const put = deferred();
    mockBackend(() => put.promise);
    const user = userEvent.setup();
    render(<Agent />);

    const prompt = await screen.findByLabelText("Instruções do agente");
    await user.type(prompt, " Seja breve.");
    await user.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await user.type(prompt, " Use o nome do cliente.");
    await settle(() => put.resolve({ ok: true }));

    expect(prompt).toHaveValue("Atenda com cordialidade. Seja breve. Use o nome do cliente.");
    expect(putBodies()).toEqual([expect.objectContaining({ systemPrompt: "Atenda com cordialidade. Seja breve." })]);
    expect(screen.queryByText("Alterações salvas.")).toBeNull();
    expect(screen.queryByText("Agente salvo")).toBeNull();
    expect(screen.queryByText("Salvando…")).toBeNull();
    // A edição feita em voo segue pendente e salvável; o legado já saiu com o PUT aceito.
    expect(screen.getByRole("button", { name: "Salvar alterações" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("PUT que termina depois da troca de alvo não leva formulário nem \"salvo\" ao novo alvo", async () => {
    const put = deferred();
    mockPerNumber(() => put.promise);
    const user = userEvent.setup();
    render(<Agent />);

    await user.type(await screen.findByLabelText("Instruções do agente"), " Seja breve.");
    await user.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await switchTo(user, SESSION, NUMBER_PROMPT);
    await settle(() => put.resolve({ ok: true }));

    expect(screen.getByLabelText("Instruções do agente")).toHaveValue(NUMBER_PROMPT);
    expect(screen.getByRole("alert")).toHaveTextContent("ferramenta_antiga_suporte");
    expect(screen.queryByText("Alterações salvas.")).toBeNull();
    expect(screen.queryByText("Agente salvo")).toBeNull();
    // O número tem o próprio legado a limpar e não ficou preso ao save do compartilhado.
    expect(screen.getByRole("button", { name: "Salvar alterações" })).toBeEnabled();
    expect(putBodies()).toEqual([expect.objectContaining({ sessionId: null, systemPrompt: "Atenda com cordialidade. Seja breve." })]);
  });

  it("falha do PUT depois da troca de alvo é avisada como do save anterior, não engolida", async () => {
    const put = deferred();
    mockPerNumber(() => put.promise);
    const user = userEvent.setup();
    render(<Agent />);

    await user.type(await screen.findByLabelText("Instruções do agente"), " Seja breve.");
    await user.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await switchTo(user, SESSION, NUMBER_PROMPT);
    await settle(() => put.reject(new Error("Falha temporária no servidor")));

    expect(screen.getByText("Não foi possível salvar as alterações feitas antes da troca: Falha temporária no servidor")).toBeInTheDocument();
    expect(screen.getByLabelText("Instruções do agente")).toHaveValue(NUMBER_PROMPT);
    expect(screen.queryByText("Agente salvo")).toBeNull();
    expect(screen.getByRole("button", { name: "Salvar alterações" })).toBeEnabled();
  });

  it("dois cliques no mesmo tick enviam um único PUT", async () => {
    const put = deferred();
    mockBackend(() => put.promise);
    const user = userEvent.setup();
    render(<Agent />);

    await user.type(await screen.findByLabelText("Instruções do agente"), " Seja breve.");
    const button = screen.getByRole("button", { name: "Salvar alterações" });
    // O `disabled` só chega no próximo render: os dois cliques ainda encontram o botão habilitado.
    act(() => {
      button.click();
      button.click();
    });
    await settle(() => put.resolve({ ok: true }));

    expect(putBodies()).toHaveLength(1);
    expect(screen.getByText("Alterações salvas.")).toBeInTheDocument();
  });
});

// O PUT /agent também grava isActive (o do formulário). Com ele e o PATCH /agent/status em voo
// juntos, vence a escrita que o servidor aplicar por último, e o selo pode mostrar o contrário do que
// ficou gravado. O mock aplica cada escrita quando ela é liberada; os testes liberam o PATCH primeiro.
function mockStatusRace() {
  const put = deferred();
  const patch = deferred();
  const server = { isActive: agent.is_active };
  apiMock.mockImplementation((path: string, options?: RequestInit) => {
    const write = (pending: Promise<unknown>) => pending.then(() => {
      server.isActive = (JSON.parse(String(options?.body)) as { isActive: boolean }).isActive;
      return { ok: true };
    });
    if (path === "/connections") return Promise.resolve({ connections: [] });
    if (path === "/agent/status") return write(patch.promise);
    if (path === "/agent" && options?.method === "PUT") return write(put.promise);
    if (path === "/agent") return Promise.resolve({ agent, available_tools: AVAILABLE, scope: "shared" });
    return Promise.reject(new Error(`rota inesperada ${path}`));
  });
  return { put, patch, server };
}

function badge() {
  return screen.getByText(/^IA (des)?ligada$/);
}

function writes() {
  return apiMock.mock.calls
    .filter(([, options]) => (options as RequestInit | undefined)?.method)
    .map(([path, options]) => `${(options as RequestInit).method} ${path}`);
}

describe("agente — status e save nunca em voo juntos", () => {
  // Desativar pede confirmação.
  beforeEach(() => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    return () => confirm.mockRestore();
  });

  it("status clicado com o save em voo, até no mesmo tick, não sai: o PUT não desfaz o status", async () => {
    const { put, patch, server } = mockStatusRace();
    const user = userEvent.setup();
    render(<Agent />);

    await user.type(await screen.findByLabelText("Instruções do agente"), " Seja breve.");
    const save = screen.getByRole("button", { name: "Salvar alterações" });
    const toggle = screen.getByRole("button", { name: "Desativar IA" });
    // O `disabled` só chega no próximo render: o segundo clique ainda encontra o botão habilitado.
    act(() => {
      save.click();
      toggle.click();
    });
    expect(toggle).toBeDisabled();
    await settle(() => {
      patch.resolve(undefined);
      put.resolve(undefined);
    });

    expect(badge()).toHaveTextContent(server.isActive ? "IA ligada" : "IA desligada");
    expect(writes()).toEqual(["PUT /agent"]);
    expect(screen.getByText("Alterações salvas.")).toBeInTheDocument();
    expect(toggle).toBeEnabled();
  });

  it("save clicado com o status em voo, até no mesmo tick, não regrava o isActive antigo e segue pendente", async () => {
    const { put, patch, server } = mockStatusRace();
    const user = userEvent.setup();
    render(<Agent />);

    await user.type(await screen.findByLabelText("Instruções do agente"), " Seja breve.");
    const save = screen.getByRole("button", { name: "Salvar alterações" });
    const toggle = screen.getByRole("button", { name: "Desativar IA" });
    act(() => {
      toggle.click();
      save.click();
    });
    expect(save).toBeDisabled();
    await settle(() => {
      patch.resolve(undefined);
      put.resolve(undefined);
    });

    expect(badge()).toHaveTextContent(server.isActive ? "IA ligada" : "IA desligada");
    expect(writes()).toEqual(["PATCH /agent/status"]);
    expect(screen.queryByText("Alterações salvas.")).toBeNull();
    // Terminado o PATCH, a edição é salva levando o status novo.
    await user.click(save);
    expect(await screen.findByText("Alterações salvas.")).toBeInTheDocument();
    expect(putBodies()).toEqual([expect.objectContaining({ isActive: false, systemPrompt: "Atenda com cordialidade. Seja breve." })]);
    expect(badge()).toHaveTextContent(server.isActive ? "IA ligada" : "IA desligada");
  });
});

// O outro número, com o próprio exclusivo (só lido).
const OTHER = CONNECTIONS[0].id;
const OTHER_PROMPT = "Atenda o comercial.";

// Estado de cada alvo no servidor (compartilhado e exclusivo do número SESSION). PUT, PATCH de status e
// DELETE do exclusivo ficam em voo e só são aplicados quando o teste os libera, na ordem liberada.
function mockTargetWrites() {
  const put = deferred();
  const patch = deferred();
  const remove = deferred();
  const clean = { ...agent, enabled_tools: ["registrar_lead"] };
  const server: { shared: typeof agent; number?: typeof agent } = { shared: clean, number: { ...clean, system_prompt: NUMBER_PROMPT } };
  apiMock.mockImplementation((path: string, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body ?? "{}")) as { sessionId?: string | null; isActive: boolean; systemPrompt: string };
    const key = body.sessionId === SESSION ? "number" : "shared";
    const write = (pending: Promise<unknown>, apply: () => void) => pending.then(() => {
      apply();
      return { ok: true };
    });
    if (path === "/connections") return Promise.resolve({ connections: CONNECTIONS });
    if (path === "/agent" && options?.method === "PUT") {
      return write(put.promise, () => { server[key] = { ...(server[key] ?? server.shared), system_prompt: body.systemPrompt, is_active: body.isActive }; });
    }
    if (path === "/agent/status") return write(patch.promise, () => { server[key] = { ...(server[key] ?? server.shared), is_active: body.isActive }; });
    if (path === `/agent/override/${SESSION}`) return write(remove.promise, () => { delete server.number; });
    if (path === "/agent") return Promise.resolve({ agent: server.shared, available_tools: AVAILABLE, scope: "shared" });
    if (path === `/agent?session_id=${SESSION}`) {
      return Promise.resolve({ agent: server.number ?? server.shared, available_tools: AVAILABLE, scope: server.number ? "connection" : "shared" });
    }
    if (path === `/agent?session_id=${OTHER}`) return Promise.resolve({ agent: { ...clean, system_prompt: OTHER_PROMPT }, available_tools: AVAILABLE, scope: "connection" });
    return Promise.reject(new Error(`rota inesperada ${path}`));
  });
  return { put, patch, remove, server };
}

const REMOVED = "Prompt exclusivo removido. O número voltou ao prompt compartilhado.";

describe("agente — escrita de um alvo não vale para outro nem sai junto com outra", () => {
  // Desativar e remover o exclusivo pedem confirmação.
  beforeEach(() => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    return () => confirm.mockRestore();
  });

  it("controle: PATCH de status aceito no mesmo alvo muda o selo e avisa", async () => {
    const { patch, server } = mockTargetWrites();
    const user = userEvent.setup();
    render(<Agent />);

    await user.click(await screen.findByRole("button", { name: "Desativar IA" }));
    await settle(() => patch.resolve(undefined));

    expect(server.shared.is_active).toBe(false);
    expect(badge()).toHaveTextContent("IA desligada");
    expect(screen.getByText("IA totalmente desativada")).toBeInTheDocument();
  });

  it("PATCH de status que termina depois da troca de alvo não muda selo, aviso nem o próximo save do novo alvo", async () => {
    const { put, patch, server } = mockTargetWrites();
    const user = userEvent.setup();
    render(<Agent />);

    await user.click(await screen.findByRole("button", { name: "Desativar IA" }));
    await switchTo(user, SESSION, NUMBER_PROMPT);
    await settle(() => patch.resolve(undefined));

    // A escrita valeu para o compartilhado; o número segue com o próprio status, sem o aviso alheio.
    expect(server.shared.is_active).toBe(false);
    expect(badge()).toHaveTextContent("IA ligada");
    expect(screen.queryByText("IA totalmente desativada")).toBeNull();

    // E o save seguinte do número grava o status dele, não o do PATCH anterior.
    put.resolve(undefined);
    await editAndSave();
    expect(await screen.findByText("Alterações salvas.")).toBeInTheDocument();
    expect(putBodies()).toEqual([expect.objectContaining({ sessionId: SESSION, isActive: true })]);
    expect(server.number?.is_active).toBe(true);
  });

  it("PATCH de status que termina depois de sair e voltar ao mesmo alvo: o alvo é relido depois dele e o save seguinte não o reverte", async () => {
    const { put, patch, server } = mockTargetWrites();
    const user = userEvent.setup();
    render(<Agent />);

    await user.click(await screen.findByRole("button", { name: "Desativar IA" }));
    await switchTo(user, SESSION, NUMBER_PROMPT);
    // Volta ao compartilhado com o PATCH dele em voo: lido antes de o PATCH ser aplicado, viria ligado.
    await user.selectOptions(screen.getByLabelText("Número que usa este prompt"), "");
    await settle(() => patch.resolve(undefined));

    expect(await screen.findByDisplayValue(agent.system_prompt)).toBeInTheDocument();
    expect(server.shared.is_active).toBe(false);
    expect(badge()).toHaveTextContent("IA desligada");
    expect(screen.getByRole("button", { name: "Ativar IA" })).toBeEnabled();

    // O save seguinte não reverte o status gravado.
    put.resolve(undefined);
    await editAndSave();
    expect(await screen.findByText("Alterações salvas.")).toBeInTheDocument();
    expect(putBodies()).toEqual([expect.objectContaining({ sessionId: null, isActive: false })]);
    expect(server.shared.is_active).toBe(false);
  });

  it("falha do PATCH depois da troca de alvo é avisada como do alvo anterior, sem mexer no selo do novo", async () => {
    const { patch, server } = mockTargetWrites();
    const user = userEvent.setup();
    render(<Agent />);

    await user.click(await screen.findByRole("button", { name: "Desativar IA" }));
    await switchTo(user, SESSION, NUMBER_PROMPT);
    await settle(() => patch.reject(new Error("Falha temporária no servidor")));

    expect(screen.getByText("Não foi possível alterar o status da IA antes da troca: Falha temporária no servidor")).toBeInTheDocument();
    expect(server.shared.is_active).toBe(true);
    expect(badge()).toHaveTextContent("IA ligada");
    expect(screen.getByRole("button", { name: "Desativar IA" })).toBeEnabled();
  });

  it("controle: sem escrita em voo, remover o exclusivo volta ao compartilhado e avisa", async () => {
    const { remove, server } = mockTargetWrites();
    const user = userEvent.setup();
    render(<Agent />);

    await screen.findByDisplayValue(agent.system_prompt);
    await switchTo(user, SESSION, NUMBER_PROMPT);
    await user.click(screen.getByRole("button", { name: "Voltar ao prompt compartilhado" }));
    await settle(() => remove.resolve(undefined));

    expect(server.number).toBeUndefined();
    expect(await screen.findByText(REMOVED)).toBeInTheDocument();
    expect(screen.getByLabelText("Número que usa este prompt")).toHaveValue("");
    expect(writes()).toEqual([`DELETE /agent/override/${SESSION}`]);
  });

  it("remover o exclusivo logo depois de salvá-lo não leva o \"salvo\" ao compartilhado", async () => {
    const { put, remove } = mockTargetWrites();
    const user = userEvent.setup();
    render(<Agent />);

    await screen.findByDisplayValue(agent.system_prompt);
    await switchTo(user, SESSION, NUMBER_PROMPT);
    put.resolve(undefined);
    await editAndSave();
    expect(await screen.findByText("Agente salvo")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Voltar ao prompt compartilhado" }));
    await settle(() => remove.resolve(undefined));

    expect(await screen.findByText(REMOVED)).toBeInTheDocument();
    expect(screen.getByLabelText("Instruções do agente")).toHaveValue(agent.system_prompt);
    expect(screen.queryByText("Agente salvo")).toBeNull();
    expect(screen.queryByRole("button", { name: "Salvo" })).toBeNull();
  });

  it("remover o exclusivo com o PUT do número em voo, até no mesmo tick, não sai: o PUT não o recria depois do aviso", async () => {
    const { put, remove, server } = mockTargetWrites();
    const user = userEvent.setup();
    render(<Agent />);

    await screen.findByDisplayValue(agent.system_prompt);
    await switchTo(user, SESSION, NUMBER_PROMPT);
    await user.type(screen.getByLabelText("Instruções do agente"), " Seja breve.");
    const save = screen.getByRole("button", { name: "Salvar alterações" });
    const back = screen.getByRole("button", { name: "Voltar ao prompt compartilhado" });
    act(() => {
      save.click();
      back.click();
    });
    expect(back).toBeDisabled();
    await settle(() => {
      remove.resolve(undefined);
      put.resolve(undefined);
    });

    // Só o PUT saiu, e a tela diz o que o servidor tem: o exclusivo salvo.
    expect(writes()).toEqual(["PUT /agent"]);
    expect(server.number?.system_prompt).toBe(`${NUMBER_PROMPT} Seja breve.`);
    expect(screen.getByText("Alterações salvas.")).toBeInTheDocument();
    expect(screen.getByText(/Este número tem um prompt exclusivo/)).toBeInTheDocument();
    expect(screen.queryByText(REMOVED)).toBeNull();

    // Terminado o PUT, a remoção sai e vale.
    await user.click(back);
    expect(await screen.findByText(REMOVED)).toBeInTheDocument();
    expect(server.number).toBeUndefined();
  });

  it("save clicado com a remoção do exclusivo em voo, até no mesmo tick, não sai: nada recria o exclusivo removido", async () => {
    const { put, remove, server } = mockTargetWrites();
    const user = userEvent.setup();
    render(<Agent />);

    await screen.findByDisplayValue(agent.system_prompt);
    await switchTo(user, SESSION, NUMBER_PROMPT);
    await user.type(screen.getByLabelText("Instruções do agente"), " Seja breve.");
    const save = screen.getByRole("button", { name: "Salvar alterações" });
    const back = screen.getByRole("button", { name: "Voltar ao prompt compartilhado" });
    act(() => {
      back.click();
      save.click();
    });
    expect(save).toBeDisabled();
    await settle(() => {
      remove.resolve(undefined);
      put.resolve(undefined);
    });

    expect(writes()).toEqual([`DELETE /agent/override/${SESSION}`]);
    expect(server.number).toBeUndefined();
    expect(await screen.findByText(REMOVED)).toBeInTheDocument();
  });

  // Remoção em voo e troca de número: o DELETE vale para o número do clique, não para o que está na tela.
  async function removeThenSwitch(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByDisplayValue(agent.system_prompt);
    await switchTo(user, SESSION, NUMBER_PROMPT);
    await user.click(screen.getByRole("button", { name: "Voltar ao prompt compartilhado" }));
    await switchTo(user, OTHER, OTHER_PROMPT);
  }

  it("remoção do exclusivo que termina depois da troca de número não leva o novo número ao compartilhado", async () => {
    const { remove, server } = mockTargetWrites();
    const user = userEvent.setup();
    render(<Agent />);

    await removeThenSwitch(user);
    await settle(() => remove.resolve(undefined));

    expect(server.number).toBeUndefined();
    expect(screen.getByLabelText("Número que usa este prompt")).toHaveValue(OTHER);
    expect(screen.getByLabelText("Instruções do agente")).toHaveValue(OTHER_PROMPT);
    expect(screen.getByText(/Este número tem um prompt exclusivo/)).toBeInTheDocument();
    expect(screen.queryByText(REMOVED)).toBeNull();
    // Terminado o DELETE, o número na tela volta a aceitar escrita.
    expect(screen.getByRole("button", { name: "Voltar ao prompt compartilhado" })).toBeEnabled();
    expect(writes()).toEqual([`DELETE /agent/override/${SESSION}`]);
  });

  it("falha da remoção depois da troca de número é avisada como do número anterior, sem mexer no novo", async () => {
    const { remove, server } = mockTargetWrites();
    const user = userEvent.setup();
    render(<Agent />);

    await removeThenSwitch(user);
    await settle(() => remove.reject(new Error("Falha temporária no servidor")));

    expect(screen.getByText("Não foi possível remover o prompt exclusivo antes da troca: Falha temporária no servidor")).toBeInTheDocument();
    expect(server.number?.system_prompt).toBe(NUMBER_PROMPT);
    expect(screen.getByLabelText("Número que usa este prompt")).toHaveValue(OTHER);
    expect(screen.getByLabelText("Instruções do agente")).toHaveValue(OTHER_PROMPT);
    expect(screen.getByRole("button", { name: "Voltar ao prompt compartilhado" })).toBeEnabled();
  });

  it("remoção que termina depois de sair e voltar ao número: ele é relido depois dela e segue na tela", async () => {
    const { remove, server } = mockTargetWrites();
    const user = userEvent.setup();
    render(<Agent />);

    await removeThenSwitch(user);
    // Volta ao número com o DELETE dele em voo: lido antes de o DELETE ser aplicado, viria com o exclusivo.
    await user.selectOptions(screen.getByLabelText("Número que usa este prompt"), SESSION);
    await settle(() => remove.resolve(undefined));

    expect(server.number).toBeUndefined();
    expect(await screen.findByDisplayValue(agent.system_prompt)).toBeInTheDocument();
    expect(screen.getByLabelText("Número que usa este prompt")).toHaveValue(SESSION);
    expect(screen.getByText(/Mostrando o prompt compartilhado/)).toBeInTheDocument();
    expect(screen.queryByText(/Este número tem um prompt exclusivo/)).toBeNull();
  });
});
