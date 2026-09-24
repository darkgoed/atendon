// @vitest-environment jsdom
// R1: opção por workspace para pedir ao contato que confirme agendamentos criados
// pela IA. Lê GET /feature-flags (flags.scheduling_meeting_confirmation_v1) e salva
// sozinha em PUT /settings/ai-meeting-confirmation {enabled} (exige agent.manage),
// sem passar pelo PUT /agent. O mock do backend responde pela sessão ativa, como o cookie.
import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, permission } = vi.hoisted(() => ({ apiMock: vi.fn(), permission: { canManage: true } }));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/use-permission", () => ({ usePermission: () => permission.canManage }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

import Agent from "../app/agente/page";

const SETTING = "/settings/ai-meeting-confirmation";
const NAME = /confirme agendamentos criados pela IA/i;

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
  enabled_tools: ["registrar_lead"]
};

let workspace = "ws-a";
let flagByWorkspace: Record<string, boolean> = {};
let putSetting: (body: { enabled: boolean }) => Promise<unknown>;

function session(id: string) {
  return {
    user: { id: "u1", email: "gestor@example.com", isRoot: false, name: "Gestor" },
    activeWorkspace: { id, name: id, slug: id, status: "active", role: "owner" },
    workspaces: [],
    permissions: ["agent.manage"],
    actorScope: "workspace"
  };
}

beforeEach(() => {
  workspace = "ws-a";
  flagByWorkspace = { "ws-a": false, "ws-b": false };
  permission.canManage = true;
  putSetting = (body) => Promise.resolve({ enabled: body.enabled });
  apiMock.mockReset();
  apiMock.mockImplementation((path: string, options?: RequestInit) => {
    if (path === "/me") return Promise.resolve(session(workspace));
    if (path === "/connections") return Promise.resolve({ connections: [] });
    if (path === "/agent" && !options?.method) return Promise.resolve({ agent, available_tools: ["registrar_lead"], scope: "shared" });
    if (path === "/feature-flags") return Promise.resolve({ flags: { scheduling_meeting_confirmation_v1: flagByWorkspace[workspace] } });
    if (path === SETTING && options?.method === "PUT") return putSetting(JSON.parse(String(options.body)));
    return Promise.reject(new Error(`rota inesperada ${options?.method ?? "GET"} ${path}`));
  });
});
afterEach(() => cleanup());

let swrMutate: ReturnType<typeof useSWRConfig>["mutate"];
function CaptureMutate() {
  swrMutate = useSWRConfig().mutate;
  return null;
}

function renderAgent() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <CaptureMutate />
      <Agent />
    </SWRConfig>
  );
}

const getSwitch = () => screen.getByRole("switch", { name: NAME });

async function readySwitch() {
  await waitFor(() => expect(getSwitch()).toBeEnabled());
  return getSwitch();
}

function calls(path: string, method?: string) {
  return apiMock.mock.calls.filter(([p, o]) => p === path && (o as RequestInit | undefined)?.method === method);
}

describe("agente — confirmação de agendamentos pela IA (R1)", () => {
  it("começa desligado quando a flag do workspace está off", async () => {
    renderAgent();

    expect(await readySwitch()).not.toBeChecked();
    expect(calls("/feature-flags").length).toBeGreaterThan(0);
  });

  it("gestor liga e a opção é salva sozinha, sem o PUT do agente", async () => {
    renderAgent();

    await userEvent.setup().click(await readySwitch());

    await waitFor(() => expect(calls(SETTING, "PUT")).toHaveLength(1));
    expect(JSON.parse(String((calls(SETTING, "PUT")[0][1] as RequestInit).body))).toEqual({ enabled: true });
    expect(await screen.findByText("Confirmação de agendamentos ativada.")).toBeInTheDocument();
    expect(getSwitch()).toBeChecked();
    expect(calls("/agent", "PUT")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Salvar alterações" })).toBeDisabled();
  });

  it("PUT com falha mantém o erro, não liga e não anuncia sucesso", async () => {
    putSetting = () => Promise.reject(new Error("Falha ao gravar a configuração"));
    renderAgent();

    await userEvent.setup().click(await readySwitch());

    expect(await screen.findByText("Falha ao gravar a configuração")).toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.getByText("Falha ao gravar a configuração")).toBeInTheDocument();
    expect(screen.queryByText(/Confirmação de agendamentos (ativada|desativada)/)).toBeNull();
    // Pode tentar de novo, ainda desligado.
    expect(await readySwitch()).not.toBeChecked();
  });

  it("sem agent.manage mostra o valor mas não deixa alterar", async () => {
    permission.canManage = false;
    flagByWorkspace["ws-a"] = true;
    renderAgent();

    await waitFor(() => expect(getSwitch()).toBeChecked());
    expect(getSwitch()).toBeDisabled();
    await userEvent.setup().click(getSwitch());

    expect(calls(SETTING, "PUT")).toHaveLength(0);
    expect(getSwitch()).toBeChecked();
  });

  it("troca de workspace na sessão refaz o GET e mostra o valor do novo workspace", async () => {
    flagByWorkspace = { "ws-a": true, "ws-b": false };
    renderAgent();
    await waitFor(() => expect(getSwitch()).toBeChecked());
    await readySwitch();
    const before = calls("/feature-flags").length;

    // Igual ao Shell: POST /workspaces/switch troca o cookie e grava a nova sessão em "/me".
    workspace = "ws-b";
    await act(async () => {
      await swrMutate("/me", session("ws-b"), { revalidate: false });
    });

    await waitFor(() => expect(calls("/feature-flags").length).toBeGreaterThan(before));
    await waitFor(() => {
      expect(getSwitch()).toBeEnabled();
      expect(getSwitch()).not.toBeChecked();
    });
  });

  it("troca de workspace não carrega o sucesso do workspace anterior", async () => {
    renderAgent();
    await userEvent.setup().click(await readySwitch());
    expect(await screen.findByText("Confirmação de agendamentos ativada.")).toBeInTheDocument();

    workspace = "ws-b";
    await act(async () => {
      await swrMutate("/me", session("ws-b"), { revalidate: false });
    });

    await waitFor(() => {
      expect(getSwitch()).toBeEnabled();
      expect(getSwitch()).not.toBeChecked();
    });
    expect(screen.queryByText("Confirmação de agendamentos ativada.")).toBeNull();
  });

  it("dois toques no mesmo tick fazem um só PUT, travam o switch e só refletem o valor salvo", async () => {
    let resolvePut: () => void = () => undefined;
    putSetting = (body) => new Promise((resolve) => {
      resolvePut = () => resolve({ enabled: body.enabled });
    });
    renderAgent();
    const toggle = await readySwitch();

    // Os dois onCheckedChange rodam antes do re-render: mesmo closure, mesmo `saving` antigo.
    await act(async () => {
      toggle.click();
      toggle.click();
    });

    expect(calls(SETTING, "PUT")).toHaveLength(1);
    expect(getSwitch()).toBeDisabled();
    expect(getSwitch()).not.toBeChecked();

    await act(async () => resolvePut());

    await waitFor(() => expect(getSwitch()).toBeEnabled());
    expect(getSwitch()).toBeChecked();
    expect(screen.getByText("Confirmação de agendamentos ativada.")).toBeInTheDocument();
    expect(calls(SETTING, "PUT")).toHaveLength(1);
  });

  it("PUT em curso ao trocar de workspace não grava o valor salvo no workspace novo", async () => {
    let resolvePut: () => void = () => undefined;
    putSetting = (body) => new Promise((resolve) => {
      resolvePut = () => resolve({ enabled: body.enabled });
    });
    renderAgent();
    await userEvent.setup().click(await readySwitch());
    await waitFor(() => expect(calls(SETTING, "PUT")).toHaveLength(1));
    const before = calls("/feature-flags").length;

    workspace = "ws-b";
    await act(async () => {
      await swrMutate("/me", session("ws-b"), { revalidate: false });
    });
    await waitFor(() => expect(calls("/feature-flags").length).toBeGreaterThan(before));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    // O PUT de ws-a termina depois da troca: ws-b mantém o próprio valor (desligado).
    await act(async () => resolvePut());

    await waitFor(() => expect(getSwitch()).toBeEnabled());
    expect(getSwitch()).not.toBeChecked();
    expect(screen.queryByText(/Confirmação de agendamentos (ativada|desativada)/)).toBeNull();
  });

  it("PUT em curso ao trocar de número segue travado, não duplica e a falha continua visível", async () => {
    // Duas conexões: o seletor troca o formulário por número. Cada PUT da opção fica pendente com o próprio reject.
    const number = "6f1d2c3b-4a5e-4f60-9b7a-8c9d0e1f2a3b";
    const rejects: Array<(cause: Error) => void> = [];
    putSetting = () => new Promise((_, reject) => { rejects.push(reject); });
    const backend = apiMock.getMockImplementation();
    apiMock.mockImplementation((path: string, options?: RequestInit) => {
      if (path === "/connections") {
        return Promise.resolve({ connections: [{ id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", label: "Comercial", is_primary: true }, { id: number, label: "Suporte", is_primary: false }] });
      }
      if (path === `/agent?session_id=${number}`) {
        return Promise.resolve({ agent: { ...agent, system_prompt: "Atenda o suporte técnico." }, available_tools: ["registrar_lead"], scope: "connection" });
      }
      return backend?.(path, options);
    });
    const user = userEvent.setup();
    renderAgent();
    await user.click(await readySwitch());
    await waitFor(() => expect(calls(SETTING, "PUT")).toHaveLength(1));

    await user.selectOptions(await screen.findByLabelText("Número que usa este prompt"), number);
    expect(await screen.findByDisplayValue("Atenda o suporte técnico.")).toBeInTheDocument();
    const locked = getSwitch().hasAttribute("disabled");
    // Segundo toque com o PUT ainda pendente (clique nativo: não sai com o switch travado).
    act(() => {
      getSwitch().click();
    });
    await act(async () => {
      rejects[0](new Error("Falha ao gravar a configuração"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect({ locked, puts: calls(SETTING, "PUT").length, error: screen.queryByText("Falha ao gravar a configuração") !== null })
      .toEqual({ locked: true, puts: 1, error: true });
    expect(await readySwitch()).not.toBeChecked();
  });
});
