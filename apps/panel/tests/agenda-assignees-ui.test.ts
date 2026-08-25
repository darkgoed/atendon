import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

let agendaActionsSource = "";
let agendaAssigneesSource = "";
let agendaCalendarSource = "";
let agendaCreateSource = "";

function between(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  expect(startIndex, `missing start marker: ${start}`).toBeGreaterThanOrEqual(0);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(endIndex, `missing end marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

beforeAll(async () => {
  [agendaActionsSource, agendaAssigneesSource, agendaCalendarSource, agendaCreateSource] = await Promise.all([
    readFile(new URL("../app/agenda/use-agenda-actions.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/agenda/use-agenda-assignees.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/agenda/agenda-calendar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/agenda/agenda-create-dialog.tsx", import.meta.url), "utf8")
  ]);
});

describe("Agenda appointment assignee selection", () => {
  it("loads closers for the chosen interval and renders the manager picker", () => {
    const createModal = between(
      agendaCreateSource,
      "export function AgendaCreateDialog(",
      "\n}"
    );

    expect(agendaAssigneesSource).toContain("/scheduling/appointment-assignees?start=");
    expect(agendaActionsSource).toContain("createStartInstant");
    expect(agendaActionsSource).toContain("createEndInstant");
    expect(createModal).toContain("Closer responsável");
    expect(createModal).toContain('aria-label="Closer responsável pela reunião"');
    expect(createModal).toContain("createAssigneesData.assignees");
    expect(createModal).toContain("assignee.selectable");
    expect(createModal).toContain("assignee.conflicts.length");
  });

  it("sends the selected closer only when the session may choose one", () => {
    const createFlow = between(
      agendaActionsSource,
      "async function createAppointment(",
      "async function runFinalAction("
    );

    expect(createFlow).toContain("createAssigneesData?.can_select_assignee === true");
    expect(createFlow).toContain("assigned_member_id: createAssignedMemberId || null");
    expect(createFlow).toContain("assignedMemberId: canSelectAssignee ? createAssignedMemberId || null : undefined");
  });

  it("keeps manual scheduling available when a time already has another lead", () => {
    const slotCell = agendaCalendarSource.slice(agendaCalendarSource.indexOf("function SlotCell("));

    expect(slotCell).toContain("const canSchedule = !availabilityFailed && canCreate;");
    expect(slotCell).toContain("const acceptsDrop = !availabilityFailed && canReschedule && Boolean(dragging);");
    expect(slotCell).toContain('? "Compartilhado"');
    expect(slotCell).toContain("um agendamento manual pode compartilhar este horário");
  });
});
