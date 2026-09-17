import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

let agendaHeader = "";
let agendaPage = "";
let agendaBlocks = "";
let conversations = "";
let conversationStatus = "";
let leadDetail = "";

beforeAll(async () => {
  [agendaHeader, agendaPage, agendaBlocks, conversations, conversationStatus, leadDetail] = await Promise.all([
    readFile(new URL("../app/agenda/agenda-header.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/agenda/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/agenda/agenda-time-blocks.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/conversas/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/conversation-status-picker.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/contatos/[id]/page.tsx", import.meta.url), "utf8")
  ]);
});

describe("comments.md August 20 regressions", () => {
  it("lets a responsible block and remove their own occupied periods", () => {
    expect(agendaHeader).toContain("Bloquear horário");
    expect(agendaPage).toContain("AgendaTimeBlockDialog");
    expect(agendaBlocks).toContain('"/scheduling/attendants/me/time-blocks"');
    expect(agendaPage).toContain("/scheduling/attendants/me/time-blocks/${id}");
    expect(agendaBlocks).toContain("A IA e o agendamento automático tratarão o período como ocupado");
  });

  it("uses Status instead of the tag picker in the conversation header", () => {
    expect(conversations).toContain("<ConversationStatusPicker");
    expect(conversations).not.toContain("<LeadTagPicker");
    expect(conversationStatus).toContain("Status");
    expect(conversationStatus).toContain("/organization/leads/${leadId}/stage");
    expect(conversationStatus).toContain("buildPipelineTransitionPayload");
  });

  it("does not filter an omitted appointments capability on lead detail", () => {
    expect(leadDetail).toContain("(data?.agendamentos ?? []).filter");
    expect(leadDetail).not.toContain("data?.agendamentos.filter");
  });
});
