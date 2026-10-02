// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api }));
vi.mock("../components/page-state", async (importOriginal) => await importOriginal<typeof import("../components/page-state")>());

import { TeamsManager, type TeamView } from "../components/teams-manager";

const teams: TeamView[] = [
  { id: "team-1", name: "Suporte nível 2", member_count: 3, active_member_count: 2 },
  { id: "team-2", name: "Comercial", member_count: 0, active_member_count: 0 }
];

function setup(canManage = true, onChanged = vi.fn()) {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <TeamsManager teams={teams} isLoading={false} loadFailed={false} canManage={canManage} onChanged={onChanged} />
    </SWRConfig>
  );
}

beforeEach(() => { cleanup(); api.mockReset(); vi.stubGlobal("confirm", vi.fn(() => true)); });

describe("teams manager", () => {
  it("lista equipes com contagem de membros ativos", async () => {
    setup();
    expect(await screen.findByText("Suporte nível 2")).toBeInTheDocument();
    expect(screen.getByText("2 ativo(s) de 3 membro(s)")).toBeInTheDocument();
    expect(screen.getByText("Comercial")).toBeInTheDocument();
  });

  it("cria equipe via POST /organization/teams e recarrega", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    setup(true, onChanged);
    await user.type(await screen.findByLabelText("Nova equipe"), "Agenda  ");
    await user.click(screen.getByRole("button", { name: "Criar equipe" }));
    const call = api.mock.calls.find(([path]) => path === "/organization/teams" );
    expect(call).toBeTruthy();
    // Nome vai aparado para o backend, que valida min(1)/max(80) e unicidade.
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ name: "Agenda" });
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("renomeia via PATCH e recarrega", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    setup(true, onChanged);
    await user.click(await screen.findByRole("button", { name: "Renomear Suporte nível 2" }));
    const input = screen.getByLabelText("Novo nome da equipe Suporte nível 2");
    await user.clear(input);
    await user.type(input, "Suporte nível 3");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    const call = api.mock.calls.find(([path]) => path === "/organization/teams/team-1");
    expect(call).toBeTruthy();
    expect((call![1] as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ name: "Suporte nível 3" });
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("exclusão sem membros pede confirmação única e chama detach_members false", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);
    api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/organization/teams/team-2" && (init as RequestInit).method === "DELETE") return { ok: true };
      return {};
    });
    setup(true, onChanged);
    await user.click(await screen.findByRole("button", { name: "Excluir Comercial" }));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const call = api.mock.calls.find(([path]) => path === "/organization/teams/team-2");
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ detach_members: false });
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("exclusão com membros: 409 dispara segunda confirmação e refaz com detach_members true", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);
    api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/organization/teams/team-1" && (init as RequestInit).method === "DELETE") {
        const body = JSON.parse((init as RequestInit).body as string);
        if (!body.detach_members) {
          return Promise.reject(new Error("Equipe possui membros vinculados; confirme a desassociação para excluir"));
        }
        return { ok: true };
      }
      return {};
    });
    setup(true, onChanged);
    await user.click(await screen.findByRole("button", { name: "Excluir Suporte nível 2" }));
    // 1ª confirmação: excluir. 2ª: desassociar membros (regra do backend 409).
    expect(confirmMock).toHaveBeenCalledTimes(2);
    const deletes = api.mock.calls.filter(([path]) => path === "/organization/teams/team-1");
    expect(JSON.parse((deletes[0]![1] as RequestInit).body as string)).toEqual({ detach_members: false });
    expect(JSON.parse((deletes[1]![1] as RequestInit).body as string)).toEqual({ detach_members: true });
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("sem permissão de gestão não oferece criar, renomear nem excluir", async () => {
    setup(false);
    expect(await screen.findByText("Suporte nível 2")).toBeInTheDocument();
    expect(screen.queryByLabelText("Nova equipe")).toBeNull();
    expect(screen.queryByRole("button", { name: "Renomear Suporte nível 2" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Excluir Suporte nível 2" })).toBeNull();
  });

  it("nome duplicado mostra o erro 409 do backend", async () => {
    const user = userEvent.setup();
    api.mockImplementation(async (path: string) => {
      if (path === "/organization/teams") return Promise.reject(new Error("Já existe uma equipe com esse nome"));
      return {};
    });
    setup(true);
    await user.type(await screen.findByLabelText("Nova equipe"), "Comercial");
    await user.click(screen.getByRole("button", { name: "Criar equipe" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Já existe uma equipe com esse nome");
  });
});
