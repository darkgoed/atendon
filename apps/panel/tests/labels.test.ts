import { describe, expect, it } from "vitest";
import {
  accessStatusLabel,
  actorScopeLabel,
  auditActionLabel,
  auditResourceLabel,
  handoffReasonLabel,
  leadEventLabel,
  leadStatusLabel,
  readableDetails
} from "../lib/labels";

describe("interface labels", () => {
  it("translates lead lifecycle states", () => {
    expect(leadStatusLabel("novo")).toBe("Novo");
    expect(leadStatusLabel("em_atendimento")).toBe("Em atendimento");
    expect(leadStatusLabel("aguardando_resposta")).toBe("Aguardando resposta");
    expect(leadStatusLabel("qualificado")).toBe("Qualificado");
    expect(leadStatusLabel("em_negociacao")).toBe("Em negociação");
    expect(leadStatusLabel("proposta_enviada")).toBe("Proposta enviada");
    expect(leadStatusLabel("follow_up")).toBe("Follow-up");
    expect(leadStatusLabel("fechado")).toBe("Fechado");
    expect(leadStatusLabel("perdido")).toBe("Perdido");
    expect(leadStatusLabel("em_qualificacao")).toBe("Em qualificação");
    expect(leadStatusLabel("aguardando_proposta")).toBe("Aguardando proposta");
  });

  it("does not expose internal handoff reason keys", () => {
    expect(handoffReasonLabel("contact_requested")).toBe("Cliente pediu atendimento");
    expect(handoffReasonLabel("technical_failure")).toBe("Falha técnica da IA");
    expect(handoffReasonLabel("commercial_handoff")).toBe("Em processo comercial");
    expect(handoffReasonLabel("unknown_internal_reason")).toBe("Transferido para atendimento humano");
  });

  it("translates access states", () => {
    expect(accessStatusLabel("revoked")).toBe("Revogado");
    expect(accessStatusLabel("active")).toBe("Ativo");
    expect(accessStatusLabel("inactive")).toBe("Inativo");
    expect(accessStatusLabel("trial")).toBe("Período de teste");
  });

  it("translates timeline and audit identifiers with a readable fallback", () => {
    expect(leadEventLabel("agendamento_reagendado")).toBe("Agendamento reagendado");
    expect(leadEventLabel("responsavel_atribuido_automaticamente")).toBe("Responsável atribuído pelo rodízio");
    expect(leadEventLabel("responsavel_reatribuido_retorno")).toBe("Responsável reatribuído no retorno");
    expect(leadEventLabel("responsavel_transferido")).toBe("Responsável transferido");
    expect(auditActionLabel("members.invitation.revoke")).toBe("Convite de membro revogado");
    expect(auditActionLabel("assignment.transferencia_manual")).toBe("Atendimento transferido manualmente");
    expect(auditActionLabel("assignment.removido_do_pool")).toBe("Atendimento redistribuído após remoção do pool");
    expect(auditResourceLabel("workspace_member")).toBe("Membro do workspace");
    expect(auditResourceLabel("scheduling_lead")).toBe("Lead");
    expect(actorScopeLabel("root")).toBe("ROOT");
    expect(auditActionLabel("custom_action_completed")).toBe("Custom action completed");
  });

  it("presents metadata without raw JSON and protects sensitive fields", () => {
    expect(readableDetails({ new_status: "aguardando_proposta", isActive: true, nested_data: { roleId: "role-1" } })).toEqual([
      { key: "new_status", label: "Novo status", value: "Aguardando proposta" },
      { key: "isActive", label: "Ativo", value: "Sim" },
      { key: "nested_data", label: "Nested data", value: "Função: role-1" }
    ]);
    expect(readableDetails({ accessToken: "secret-value", openRouterApiKey: "sk-test" })).toEqual([
      { key: "accessToken", label: "Access token", value: "Conteúdo protegido" },
      { key: "openRouterApiKey", label: "Chave da OpenRouter", value: "Conteúdo protegido" }
    ]);
    expect(readableDetails(null)).toEqual([]);
  });

  it("never crashes on null or undefined status values from the API", () => {
    // Regressão: "Cannot read properties of null (reading 'trim')".
    expect(leadStatusLabel(null)).toBe("Não informado");
    expect(leadStatusLabel(undefined)).toBe("Não informado");
    expect(accessStatusLabel(null)).toBe("Não informado");
    expect(auditActionLabel(null)).toBe("Não informado");
    expect(actorScopeLabel(undefined)).toBe("Não informado");
  });
});
