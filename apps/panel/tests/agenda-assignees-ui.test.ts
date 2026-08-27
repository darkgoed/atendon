// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { AgendaCalendar } from "../app/agenda/agenda-calendar";

let agendaActionsSource = "";
let agendaAssigneesSource = "";
let globalsSource = "";
beforeAll(async () => {
  [agendaActionsSource, agendaAssigneesSource, globalsSource] = await Promise.all([
    readFile(resolve(process.cwd(), "app/agenda/use-agenda-actions.ts"), "utf8"),
    readFile(resolve(process.cwd(), "app/agenda/use-agenda-assignees.ts"), "utf8"),
    readFile(resolve(process.cwd(), "app/globals.css"), "utf8")
  ]);
});

describe("Agenda appointment assignee selection", () => {
  it("loads closers for the chosen interval and supports manager selection", () => {
    expect(agendaAssigneesSource).toContain("/scheduling/appointment-assignees?start=");
    expect(agendaActionsSource).toContain("createStartInstant");
    expect(agendaActionsSource).toContain("createEndInstant");
    expect(agendaActionsSource).toContain("assigned_member_id: createAssignedMemberId || null");
    expect(agendaActionsSource).toContain("assignedMemberId: canSelectAssignee ? createAssignedMemberId || null : undefined");
  });

  it("renders availability as screen-reader text with an aria-label and no title attributes", () => {
    const day = new Date("2026-01-01T00:00:00Z");
    render(React.createElement(AgendaCalendar, { days: [day], today: "2026-01-01", timezone: "UTC", failedDays: [], now: 0, dragging: "", reschedulingId: "", pendingActionId: "", canReschedule: false, canCreate: true, timeGrid: { byDay: new Map([["2026-01-01", new Map([["09:00", { start: "2026-01-01T09:00:00Z", end: "2026-01-01T10:00:00Z", vagas: 0, capacidade: 1, ocupados_no_inicio: 1 }]])]]), appointmentsByDay: new Map(), labels: ["09:00"] }, onDrag: () => undefined, onDrop: () => undefined, onCreate: () => undefined, onOpen: () => undefined }));
    const availability = screen.getByLabelText("Disponibilidade: Compartilhado");
    expect(availability.classList.contains("sr-only")).toBe(true);
    expect(availability.textContent).toBe("Compartilhado");
    expect(document.querySelectorAll("[title]")).toHaveLength(0);
  });

  it("keeps manual scheduling available when a time already has another lead", () => {
    expect(globalsSource).not.toMatch(/agenda-cell[^\n]*:(?:hover|focus-within)[^\n]*agenda-cell__vagas/);
    expect(globalsSource).toContain(".agenda-cell__vagas");
  });
});
