// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMock }));

import { AgendaTimeBlockList, timeBlockDeletePath } from "../app/agenda/agenda-time-blocks";
import { useAgendaData } from "../app/agenda/use-agenda-data";

// Auditoria P1 F6: bloqueio recorrente criado no painel precisa aparecer na
// agenda e ser removível pelo endpoint de recorrentes.
const ONE_OFF = { id: "block-1", member_id: "m-1", start: "2026-10-05T15:00:00.000Z", end: "2026-10-05T16:00:00.000Z", reason: "Médico", created_at: "2026-10-01T10:00:00.000Z" };
const RECURRING_OCCURRENCE = {
  id: "rule-1", rule_id: "rule-1", origin: "recorrente", member_id: "m-1",
  start: "2026-10-06T15:00:00.000Z", end: "2026-10-06T16:00:00.000Z", reason: "Almoço", created_at: "2026-10-01T10:00:00.000Z"
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("agenda — bloqueios recorrentes", () => {
  it("carrega ocorrências recorrentes junto com os bloqueios pontuais", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/scheduling/config/unidades") return Promise.resolve({ unidades: [{ id: "unit", nome: "Unidade" }] });
      if (path.startsWith("/scheduling/appointments")) return Promise.resolve({ agendamentos: [], timezone: "America/Sao_Paulo" });
      if (path.startsWith("/scheduling/availability")) return Promise.resolve({ data: "2026-10-05", timezone: "America/Sao_Paulo", horarios: [] });
      if (path.startsWith("/scheduling/attendants/me/time-blocks")) return Promise.resolve({ blocks: [ONE_OFF] });
      if (path.startsWith("/scheduling/attendants/me/recurring-time-blocks")) return Promise.resolve({ blocks: [RECURRING_OCCURRENCE, { ...RECURRING_OCCURRENCE, start: "2026-10-07T15:00:00.000Z", end: "2026-10-07T16:00:00.000Z" }] });
      return Promise.resolve({});
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>;
    const { result } = renderHook(() => useAgendaData({ requestedUnit: "unit", requestedDate: "2026-10-05", requestedAppointmentId: "" }), { wrapper });
    await waitFor(() => expect(result.current.timeBlocks).toHaveLength(3));
    const recurring = result.current.timeBlocks.filter((block) => block.rule_id);
    expect(recurring.map((block) => block.rule_id)).toEqual(["rule-1", "rule-1"]);
    // Chaves únicas por ocorrência (a regra repete o mesmo id).
    expect(new Set(result.current.timeBlocks.map((block) => block.id)).size).toBe(3);
    expect(apiMock.mock.calls.some(([path]) => String(path).startsWith("/scheduling/attendants/me/recurring-time-blocks?start="))).toBe(true);
  });

  it("lista a ocorrência como recorrente e remove pela regra", async () => {
    const onDelete = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AgendaTimeBlockList blocks={[ONE_OFF, { ...RECURRING_OCCURRENCE, id: "rule-1:2026-10-06T15:00:00.000Z" }]} timezone="America/Sao_Paulo" deletingId="" onDelete={onDelete} />);
    expect(screen.getByText(/Recorrente/)).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: /Remover bloqueio/ });
    await userEvent.click(buttons[1]);
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ rule_id: "rule-1" }));
    expect(timeBlockDeletePath({ ...RECURRING_OCCURRENCE, id: "rule-1:x" })).toBe("/scheduling/attendants/me/recurring-time-blocks/rule-1");
    expect(timeBlockDeletePath(ONE_OFF)).toBe("/scheduling/attendants/me/time-blocks/block-1");
  });
});
