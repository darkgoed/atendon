// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgendaCalendar } from "./agenda-calendar";

const slot = { start: "2026-09-03T09:00:00.000Z", end: "2026-09-03T10:00:00.000Z", vagas: 2, capacidade: 2, ocupados_no_inicio: 0 };

describe("SlotCell", () => {
  it("keeps the free slot itself accessible and selectable without a contextual Agendar button", () => {
    const onSelectSlot = vi.fn();
    render(<AgendaCalendar days={[new Date("2026-09-03T00:00:00.000Z")]} today="2026-09-03" timezone="UTC" failedDays={[]} timeGrid={{ byDay: new Map([["2026-09-03", new Map([["09:00", slot]])]]), appointmentsByDay: new Map(), labels: ["09:00"] }} now={0} dragging="" reschedulingId="" pendingActionId="" canReschedule={false} canCreate onDrag={vi.fn()} onDrop={vi.fn()} onCreate={vi.fn()} onOpen={vi.fn()} onSelectSlot={onSelectSlot} />);

    const cell = screen.getByRole("button", { name: /2 livres/i });
    expect(cell).toBeVisible();
    // A própria célula é o único botão: a prévia "Agendar às…" faz parte do
    // nome dela (ajuda contextual), não um botão extra.
    expect(screen.getAllByRole("button")).toEqual([cell]);
    expect(cell).toHaveAccessibleName(/Agendar às 09:00/);
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: "Enter" });
    fireEvent.keyDown(cell, { key: " " });
    expect(onSelectSlot).toHaveBeenCalledTimes(3);
  });
});
