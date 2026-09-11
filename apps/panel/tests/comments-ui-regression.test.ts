import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

let agendaActionsSource = "";
let agendaCalendarSource = "";
let agendaCreateSource = "";
let agendaDetailSource = "";
let agendaHeaderSource = "";
let configurationsSource = "";
let conversationsSource = "";
let globalStyles = "";
let leadDetailSource = "";
let leadsSource = "";
let pipelineSource = "";
let pipelineBoardSource = "";
let pipelineCardSource = "";
let shellSource = "";
let manifestSource = "";

function between(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  expect(startIndex, `missing start marker: ${start}`).toBeGreaterThanOrEqual(0);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(endIndex, `missing end marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

beforeAll(async () => {
  [agendaActionsSource, agendaCalendarSource, agendaCreateSource, agendaDetailSource, agendaHeaderSource, configurationsSource, conversationsSource, globalStyles, leadDetailSource, leadsSource, pipelineSource, pipelineBoardSource, pipelineCardSource, shellSource, manifestSource] = await Promise.all([
    readFile(new URL("../app/agenda/use-agenda-actions.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/agenda/agenda-calendar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/agenda/agenda-create-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/agenda/agenda-detail-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/agenda/agenda-header.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/configuracoes/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/conversas/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/leads/[id]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/leads/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/leads/pipeline/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/pipeline-board.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/pipeline-card.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/shell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/panel-manifest.ts", import.meta.url), "utf8")
  ]);
});

describe("comments.md UI regressions", () => {
  it("keeps resolving and transferring in the conversation header and scheduling in More", () => {
    const header = between(
      conversationsSource,
      '<header className="conversation-thread__header',
      "</header>"
    );
    const actionsIndex = header.indexOf('className="conversation-thread__actions');
    const moreIndex = header.indexOf('ariaLabel="Mais ações da conversa"');

    expect(actionsIndex).toBeGreaterThanOrEqual(0);
    expect(moreIndex).toBeGreaterThan(actionsIndex);
    expect(header.slice(actionsIndex, moreIndex)).not.toMatch(/\bAgendar\b/);
    expect(header.slice(actionsIndex, moreIndex)).toMatch(/\bResolver\b/);
    expect(header.slice(actionsIndex, moreIndex)).toMatch(/\bTransferir\b/);

    const moreActions = header.slice(moreIndex);
    expect(moreActions).toMatch(/\bAgendar\b/);
    expect(moreActions).toContain("Avaliar com IA");
    expect(moreActions).toContain("Assumir conversa");
    expect(moreActions).toContain("Assinatura do atendente");
    expect(moreActions).toContain("Reativar IA");
    expect(moreActions).toContain("Pausar IA neste contato");
  });

  it("exposes configuration only through the gear entry and centralizes destinations in its hub", () => {
    const destinations = between(
      configurationsSource,
      "const settingsDestinations:",
      "export default function ConfigPage"
    );

    expect(manifestSource).toContain('{ href: "/configuracoes", label: "Configurações"');
    for (const path of [
      "/conexao",
      "/workspace/members",
      "/workspace/roles",

      "/workspace/audit",
      "/agente",
      "/humanizacao",
      "/uso"
    ]) {
      expect(manifestSource).toContain(`"${path}"`);
      expect(destinations).toContain(`href: "${path}"`);
    }
    expect(shellSource).toContain("findPanelManifestItem(path)");
  });

  it("keeps appointment cards limited to contact, status and responsible, opening actions and notes in a modal", () => {
    const appointmentCard = between(
      agendaCalendarSource,
      "{items.map((item) => (\n          <article",
      "</article>"
    );
    const detailModal = agendaDetailSource;

    expect(appointmentCard).toContain('className="agenda-appointment__contact"');
    expect(agendaCalendarSource).toContain("agenda-cell__appointments--shared");
    expect(agendaCalendarSource).toContain('"--appointment-columns": Math.max(items.length, 1)');
    expect(appointmentCard).toContain("APPOINTMENT_STATUS_LABELS[item.status]");
    expect(appointmentCard).toContain('item.responsavel?.email ?? "Sem responsável"');
    expect(appointmentCard).toContain('"--appointment-color": item.responsavel?.cor_agenda');
    expect(appointmentCard).not.toContain("agenda-appointment__actions");
    expect(appointmentCard.match(/<button\b/g)).toHaveLength(1);

    expect(detailModal).toContain('<ModalDialog');
    expect(detailModal).toContain("Abrir conversa");
    expect(detailModal).toContain("Iniciar conversa");
    expect(detailModal).toContain("openConversation(selectedAppointment)");
    expect(detailModal).toContain("Entrar no Meet");
    expect(detailModal).toContain("Reagendar");
    expect(detailModal).toContain("Concluir");
    expect(detailModal).toContain("Não compareceu");
    expect(detailModal).toContain("Cancelar");
    expect(detailModal).toContain('value={appointmentObservation}');
    expect(agendaDetailSource).toContain('readOnly={!permissions.canManageNotes}');
    expect(detailModal).toContain("Salvar observação");
    expect(detailModal).toContain("isActiveAppointment(selectedAppointment.status)");
    expect(agendaHeaderSource).toContain('aria-label="Filtrar agendamentos por situação"');
    expect(agendaHeaderSource).toContain('["finished", "Finalizados"]');
  });

  it("uses a 60-minute duration and persists a new Agenda contact before scheduling it", () => {
    const createFlow = between(
      agendaActionsSource,
      "async function createAppointment(",
      "async function runFinalAction("
    );
    const createModal = between(
      agendaCreateSource,
      "export function AgendaCreateDialog(",
      "\n}"
    );

    expect(agendaHeaderSource).toContain("onClick={onCreate}");
    expect(createModal).toContain("Novo contato");
    expect(createModal).toContain("Nome do contato");
    expect(createModal).toContain("Número / WhatsApp");
    expect(createModal).toContain('placeholder="12 99606-2155"');
    expect(createModal).toContain("formatBrazilianPhone(event.target.value)");
    expect(createModal).not.toContain("+55");
    expect(createModal).toContain('type="datetime-local" value={selectedStart}');
    expect(createModal).not.toContain('value={createEnd}');
    expect(createModal).not.toContain("Término");
    expect(createModal).toContain("a reunião terá 60 minutos");
    expect(createModal).toContain("conflitos permanecem bloqueados");
    const leadRequestIndex = createFlow.indexOf('"/scheduling/leads"');
    const appointmentRequestIndex = createFlow.indexOf('"/scheduling/appointments"');
    expect(leadRequestIndex).toBeGreaterThanOrEqual(0);
    expect(appointmentRequestIndex).toBeGreaterThan(leadRequestIndex);
    expect(createFlow).toContain("leadId = response.lead.id");
    expect(createFlow).toContain("lead_id: leadId");
    expect(createFlow).toContain("DEFAULT_APPOINTMENT_DURATION_MS");
    expect(createFlow).toContain("end: createEnd");
    expect(createFlow).not.toContain("mutateAppointmentLeads()");
  });

  it("lets managers configure responsible colors and projects those colors into Agenda cards", () => {
    expect(configurationsSource).toContain(
      "`/scheduling/attendants/${member.member_id}/calendar-color`"
    );
    expect(configurationsSource).toContain('type="color"');
    expect(configurationsSource).toContain("value={colorDraft}");
    expect(configurationsSource).toContain("Salvar cor");
    // O handoff B2B renomeou o token da cor primária para --primary; a cor do
    // responsável continua projetada no card da agenda, agora com esse fallback.
    expect(agendaCalendarSource).toContain(
      '"--appointment-color": item.responsavel?.cor_agenda ?? "var(--primary)"'
    );
  });

  it("keeps the pipeline viewport fixed with independent scrolling and an accessible move action", () => {
    expect(pipelineSource).toContain("<Shell fitViewport>");
    expect(pipelineBoardSource).toContain("overflow-x-auto overflow-y-hidden overscroll-contain");
    expect(pipelineBoardSource).toContain("flex-1 flex-col overflow-y-auto");
    expect(pipelineBoardSource).toContain('aria-label="Quadro de pipeline"');
    expect(pipelineCardSource).toContain(">Mover</button>");
    expect(pipelineCardSource).not.toContain("md:hidden");
  });

  it("adds scheduled conversations alongside the existing queue filters", () => {
    const tabs = between(conversationsSource, '["human", "Abertas"', "].map(([key, label, count])");
    expect(tabs).toContain('["ai", "IA"');
    expect(tabs).toContain('["scheduled", "Agendadas"');
    expect(tabs).toContain('["resolved", "Resolvidas"');
  });

  it("keeps the leads table compact and single-line while truncating its summary", () => {
    expect(leadsSource).toContain("responsive-table leads-table");
    expect(leadsSource).toContain('data-label="Resumo"');
    expect(leadsSource).toContain('className="block truncate" title=');
    expect(leadsSource).toContain("whitespace-nowrap");
    expect(leadsSource).toContain("flex flex-nowrap");
    expect(leadsSource).toContain("min-h-8");
  });

  it("edits lead identity through the synchronized panel endpoint", () => {
    expect(leadDetailSource).toContain('aria-label="Editar nome e telefone"');
    expect(leadDetailSource).toContain("/scheduling/leads/${id}/identity");
    expect(leadDetailSource).toContain('aria-label="Nome do contato"');
    expect(leadDetailSource).toContain('aria-label="Telefone do contato"');
  });

  it("shows only the useful qualification summary in the lead detail", () => {
    expect(leadDetailSource).toContain("data.qualificacao.resumo ?? \"—\"");
    expect(leadDetailSource).toContain("data.qualificacao.estrelas");
    expect(leadDetailSource).toContain("requer_decisao_humana");
    expect(leadDetailSource).not.toContain("Respostas estruturadas");
    expect(leadDetailSource).not.toContain("Nenhuma resposta estruturada foi registrada");
    expect(leadDetailSource).not.toContain("Justificativa interna");
    expect(leadDetailSource).not.toContain("qualificacao.justificativa");
  });

  // O dump completo das respostas continua fora do detalhe do lead. Decisor e
  // momento de compra são a exceção pedida pelo comercial: preparam o closer
  // para a call e passam por uma seleção explícita, não por despejo do jsonb.
  it("shows only decision maker and buying moment from the structured answers", () => {
    expect(leadDetailSource).toContain("commercialPreparationAnswers(data.qualificacao.respostas)");
    expect(leadDetailSource).not.toContain("readableQualificationAnswers(data.qualificacao.respostas)");
  });

  it("does not render the lead detail timeline", () => {
    expect(leadDetailSource).not.toContain("ReadableDetails");
    expect(leadDetailSource).not.toContain("leadEventLabel");
    expect(leadDetailSource).not.toContain("Timeline");
    expect(leadDetailSource).not.toContain("data.eventos");
  });

  it("reserves an internal top lane for usage tooltips so hover content is not clipped", () => {
    const usageStyles = between(globalStyles, "/* Uso —", "/* Login —");
    expect(usageStyles).toContain("padding:72px 12px 28px");
    expect(usageStyles).toContain("top:-62px");
    expect(usageStyles).toContain("max-height:128px");
  });
});
