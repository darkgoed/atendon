// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api }));

import { LeadMergeDialog, type LeadMergePairItem } from "../components/lead-merge-dialog";

const ana: LeadMergePairItem = { id: "lead-ana", nome: "Ana", telefone: "5511999990000" };
const anaDup: LeadMergePairItem = { id: "lead-ana-2", nome: "Ana (2)", telefone: "5511999990000" };
const outra: LeadMergePairItem = { id: "lead-outra", nome: "Outra", telefone: "5511988887777" };

function setup(pair: [LeadMergePairItem, LeadMergePairItem], onMerged = vi.fn(), onClose = vi.fn()) {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <LeadMergeDialog open pair={pair} onClose={onClose} onMerged={onMerged} />
    </SWRConfig>
  );
}

function callsFor(path: string) { return api.mock.calls.filter(([calledPath]) => calledPath === path); }

beforeEach(() => { cleanup(); api.mockReset(); });

describe("lead merge dialog", () => {
  it("analisar envia preflight com principal escolhido como target e o outro como source", async () => {
    const user = userEvent.setup();
    api.mockImplementation(async () => ({ same_normalized_phone: true, conflicts: { conversations: 2, tasks: 0, tags: 1, pipeline_positions: 0, notes: 0, custom_fields: 0, appointments: 0 } }));
    setup([ana, anaDup]);
    // Principal padrão = primeiro selecionado; troca para "Ana (2)".
    const ana2Radio = screen.getByRole("radio", { name: /Ana \(2\)/ });
    await user.click(ana2Radio);
    await user.click(screen.getByRole("button", { name: "Analisar mesclagem" }));
    const preflight = callsFor("/organization/leads/merge/preflight")[0];
    expect(preflight).toBeTruthy();
    expect(JSON.parse((preflight![1] as RequestInit).body as string)).toEqual({ source_id: "lead-ana", target_id: "lead-ana-2" });
    expect(await screen.findByText(/Serão movidos: 2 conversa\(s\), 1 etiqueta\(s\)/)).toBeInTheDocument();
  });

  it("mesmo telefone: merge sem confirmações e sucesso lista o que foi movido", async () => {
    const user = userEvent.setup();
    const onMerged = vi.fn();
    api.mockImplementation(async (path: string) => {
      if (path === "/organization/leads/merge/preflight") {
        return { source_id: "lead-ana-2", target_id: "lead-ana", same_normalized_phone: true, conflicts: { conversations: 1, tasks: 0, tags: 0, pipeline_positions: 0, notes: 0, custom_fields: 0, appointments: 0 } };
      }
      if (path === "/organization/leads/merge") {
        return { target: { id: "lead-ana", phone: "5511999990000", name: "Ana" }, moved: { conversations: 1, notes: 0, tasks: 0, tags: 3, custom_values: 0, appointments: 0, flow_states: 0, flow_log: 0, lead_events: 0, post_sales: 0 } };
      }
      return {};
    });
    setup([ana, anaDup], onMerged);
    await user.click(screen.getByRole("button", { name: "Analisar mesclagem" }));
    expect(await screen.findByText(/telefones coincidem/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Mesclar contatos" }));
    const merge = callsFor("/organization/leads/merge")[0];
    expect(JSON.parse((merge![1] as RequestInit).body as string)).toEqual({ source_id: "lead-ana-2", target_id: "lead-ana" });
    expect(await screen.findByText(/Movidos para o contato principal: 1 conversa\(s\), 3 etiqueta\(s\)/)).toBeInTheDocument();
    expect(onMerged).toHaveBeenCalledTimes(1);
  });

  it("telefones diferentes: submit bloqueado até marcar a confirmação explícita", async () => {
    const user = userEvent.setup();
    api.mockImplementation(async (path: string) => {
      if (path === "/organization/leads/merge/preflight") {
        return { source_id: "lead-outra", target_id: "lead-ana", same_normalized_phone: false, conflicts: { conversations: 0, tasks: 0, tags: 0, pipeline_positions: 1, notes: 0, custom_fields: 0, appointments: 0 } };
      }
      return {};
    });
    setup([ana, outra]);
    await user.click(screen.getByRole("button", { name: "Analisar mesclagem" }));
    expect(await screen.findByText(/Só confirme se tiver certeza/)).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Mesclar contatos" }) as HTMLButtonElement;
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    expect(submit).not.toBeDisabled();
    api.mockImplementation(async (path: string) => {
      if (path === "/organization/leads/merge") return { target: { id: "lead-ana", phone: "5511999990000", name: "Ana" }, moved: {} };
      return {};
    });
    await user.click(submit);
    const merge = await vi.waitFor(() => {
      const call = callsFor("/organization/leads/merge")[0];
      expect(call).toBeTruthy();
      return call!;
    });
    expect(JSON.parse((merge[1] as RequestInit).body as string)).toEqual({
      source_id: "lead-outra",
      target_id: "lead-ana",
      confirmations: { different_phone: true }
    });
  });

  it("erro no merge (ex.: contato já mesclado) volta ao passo 1 com a mensagem", async () => {
    const user = userEvent.setup();
    api.mockImplementation(async (path: string) => {
      if (path === "/organization/leads/merge/preflight") {
        return { source_id: "lead-ana-2", target_id: "lead-ana", same_normalized_phone: true, conflicts: { conversations: 0, tasks: 0, tags: 0, pipeline_positions: 0, notes: 0, custom_fields: 0, appointments: 0 } };
      }
      if (path === "/organization/leads/merge") {
        return Promise.reject(new Error("Este contato já foi mesclado ou está na lixeira"));
      }
      return {};
    });
    setup([ana, anaDup]);
    await user.click(screen.getByRole("button", { name: "Analisar mesclagem" }));
    await screen.findByText(/telefones coincidem/);
    await user.click(screen.getByRole("button", { name: "Mesclar contatos" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Este contato já foi mesclado ou está na lixeira");
    // De volta ao passo de escolha: radios novamente visíveis.
    expect(screen.getByRole("radio", { name: /Ana \(2\)/ })).toBeInTheDocument();
  });

  it("preflight sem vínculos mostra estado vazio e o aviso de etapa divergente", async () => {
    const user = userEvent.setup();
    api.mockImplementation(async () => ({ source_id: "lead-ana-2", target_id: "lead-ana", same_normalized_phone: true, conflicts: { conversations: 0, tasks: 0, tags: 0, pipeline_positions: 1, notes: 0, custom_fields: 0, appointments: 0 } }));
    setup([ana, anaDup]);
    await user.click(screen.getByRole("button", { name: "Analisar mesclagem" }));
    expect(await screen.findByText(/Nenhum vínculo para mover/)).toBeInTheDocument();
    expect(screen.getByText(/vale a etapa do contato principal/)).toBeInTheDocument();
    const form = screen.getByRole("button", { name: "Mesclar contatos" }).closest("form");
    expect(form).toBeTruthy();
    expect(within(form as HTMLElement).getByRole("button", { name: "Voltar" })).toBeInTheDocument();
  });

  it("erro de preflight aparece e mantém o passo de escolha", async () => {
    const user = userEvent.setup();
    api.mockImplementation(async (path: string) => {
      if (path === "/organization/leads/merge/preflight") return Promise.reject(new Error("Contato não encontrado"));
      return {};
    });
    setup([ana, anaDup]);
    await user.click(screen.getByRole("button", { name: "Analisar mesclagem" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Contato não encontrado");
    expect(screen.getByRole("button", { name: "Analisar mesclagem" })).toBeInTheDocument();
  });
});
