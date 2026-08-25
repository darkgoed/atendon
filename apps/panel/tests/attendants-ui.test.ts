import { describe, expect, it } from "vitest";
import {
  attendantPoolAccess,
  attendantControlState,
  attendantPanelState,
  attendantPoolSavedMessage,
  availabilityLabel
} from "../lib/attendants";

describe("attendant availability UI states", () => {
  it("keeps the conversation attendant pool accessible without the appointments module", () => {
    expect(attendantPoolAccess({
      hasWorkspaceScope: true,
      canReadUnits: true,
      canManageUnits: true
    })).toEqual({ canRead: true, canManage: true });
    expect(attendantPoolAccess({
      hasWorkspaceScope: false,
      canReadUnits: true,
      canManageUnits: true
    })).toEqual({ canRead: false, canManage: false });
  });

  it("labels the persistent availability states", () => {
    expect(availabilityLabel("available")).toBe("Disponível");
    expect(availabilityLabel("unavailable")).toBe("Indisponível");
    expect(availabilityLabel(null)).toBe("Fora do pool");
  });

  it("allows managers to choose only the opposite status for persisted pool members", () => {
    expect(attendantControlState({
      canManage: true,
      selected: true,
      persistedInPool: true,
      status: "available",
      changing: false
    })).toEqual({ canSetAvailable: false, canSetUnavailable: true });
    expect(attendantControlState({
      canManage: true,
      selected: true,
      persistedInPool: true,
      status: "unavailable",
      changing: false
    })).toEqual({ canSetAvailable: true, canSetUnavailable: false });
  });

  it.each([
    { canManage: false, selected: true, persistedInPool: true, changing: false },
    { canManage: true, selected: false, persistedInPool: true, changing: false },
    { canManage: true, selected: true, persistedInPool: false, changing: false },
    { canManage: true, selected: true, persistedInPool: true, changing: true }
  ])("disables availability controls without permission, selection, persistence or while saving", (state) => {
    expect(attendantControlState({ ...state, status: "available" })).toEqual({
      canSetAvailable: false,
      canSetUnavailable: false
    });
  });

  it("distinguishes loading, errors, empty data and ready data", () => {
    expect(attendantPanelState({ loading: true, hasData: false, hasError: false, count: 0 })).toBe("loading");
    expect(attendantPanelState({ loading: false, hasData: false, hasError: true, count: 0 })).toBe("error");
    expect(attendantPanelState({ loading: false, hasData: true, hasError: false, count: 0 })).toBe("empty");
    expect(attendantPanelState({ loading: false, hasData: true, hasError: false, count: 2 })).toBe("ready");
  });

  it("reports every redistributed case while preserving the legacy appointment counter", () => {
    expect(attendantPoolSavedMessage({
      redistribuidos: 2,
      redistribuidos_leads: 3,
      redistribuidos_conversas: 1
    })).toBe("Equipe salva. Redistribuídos: 3 lead(s), 1 conversa(s), 2 reunião(ões).");
    expect(attendantPoolSavedMessage({ redistribuidos_reunioes: 4 }))
      .toBe("Equipe salva. Redistribuídos: 4 reunião(ões).");
    expect(attendantPoolSavedMessage({})).toBe("Equipe de atendimento salva.");
  });
});
