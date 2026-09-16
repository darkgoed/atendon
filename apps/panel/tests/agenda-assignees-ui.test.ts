// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AgendaCalendar } from "../app/agenda/agenda-calendar";
import { readStyleSources } from "./style-sources";

let agendaActionsSource = "";
const readStyleSource = async () => readStyleSources();

let agendaAssigneesSource = "";
let globalsSource = "";
beforeAll(async () => {
  [agendaActionsSource, agendaAssigneesSource, globalsSource] = await Promise.all([
    readFile(resolve(process.cwd(), "app/agenda/use-agenda-actions.ts"), "utf8"),
    readFile(resolve(process.cwd(), "app/agenda/use-agenda-assignees.ts"), "utf8"),
    readStyleSource()
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

  it("keeps occupied cells non-interactive while free cells remain keyboard schedulable", () => {
    const day = new Date("2026-01-01T00:00:00Z");
    const slot = { start: "2026-01-01T09:00:00Z", end: "2026-01-01T10:00:00Z", vagas: 1, capacidade: 1 };
    const appointment = { id: "appointment-1", lead_id: "lead-1", start: slot.start, end: slot.end, status: "confirmado" as const, lead_nome: "Ana", lead_telefone: "+5511999999999", atualizado_em: slot.start };
    const onSelectSlot = vi.fn();
    const occupiedRender = render(React.createElement(AgendaCalendar, { days: [day], today: "2026-01-01", timezone: "UTC", failedDays: [], now: 0, dragging: "", reschedulingId: "", pendingActionId: "", canReschedule: false, canCreate: true, timeGrid: { byDay: new Map([["2026-01-01", new Map([["09:00", slot]])]]), appointmentsByDay: new Map([["2026-01-01", new Map([["09:00", [appointment]]])]]), labels: ["09:00"] }, onDrag: () => undefined, onDrop: () => undefined, onCreate: () => undefined, onOpen: () => undefined, onSelectSlot }));
    const occupiedCell = occupiedRender.container.querySelector(".agenda-cell")!;
    expect(occupiedCell).not.toHaveAttribute("role");
    expect(occupiedCell).not.toHaveAttribute("tabindex");
    expect(occupiedCell.querySelector("button")).toBeInTheDocument();

    cleanup();
    const freeRender = render(React.createElement(AgendaCalendar, { days: [day], today: "2026-01-01", timezone: "UTC", failedDays: [], now: 0, dragging: "", reschedulingId: "", pendingActionId: "", canReschedule: false, canCreate: true, timeGrid: { byDay: new Map([["2026-01-01", new Map([["09:00", slot]])]]), appointmentsByDay: new Map(), labels: ["09:00"] }, onDrag: () => undefined, onDrop: () => undefined, onCreate: () => undefined, onOpen: () => undefined, onSelectSlot }));
    const freeCell = freeRender.container.querySelector(".agenda-cell")!;
    expect(freeCell).toHaveAttribute("role", "button");
    expect(freeCell).toHaveAttribute("tabindex", "0");
    freeCell.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onSelectSlot).toHaveBeenCalledTimes(1);
  });
});
