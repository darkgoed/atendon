export type AttendantAvailability = "available" | "unavailable";

export type AttendantRedistributionCounts = {
  redistribuidos?: number;
  redistribuidos_leads?: number;
  redistribuidos_conversas?: number;
  redistribuidos_reunioes?: number;
};

export function attendantPoolAccess(input: {
  hasWorkspaceScope: boolean;
  canReadUnits: boolean;
  canManageUnits: boolean;
}) {
  return {
    canRead: input.hasWorkspaceScope && input.canReadUnits,
    canManage: input.hasWorkspaceScope && input.canManageUnits
  };
}

export function availabilityLabel(status: AttendantAvailability | null | undefined) {
  if (status === "available") return "Disponível";
  if (status === "unavailable") return "Indisponível";
  return "Fora do pool";
}

export function attendantPoolSavedMessage(counts: AttendantRedistributionCounts) {
  const leads = counts.redistribuidos_leads ?? 0;
  const conversations = counts.redistribuidos_conversas ?? 0;
  const appointments = counts.redistribuidos_reunioes ?? counts.redistribuidos ?? 0;
  if (leads + conversations + appointments === 0) return "Equipe de atendimento salva.";
  const parts = [
    leads ? `${leads} lead(s)` : "",
    conversations ? `${conversations} conversa(s)` : "",
    appointments ? `${appointments} reunião(ões)` : ""
  ].filter(Boolean);
  return `Equipe salva. Redistribuídos: ${parts.join(", ")}.`;
}

export function attendantControlState(input: {
  canManage: boolean;
  selected: boolean;
  persistedInPool: boolean;
  status: AttendantAvailability | null;
  changing: boolean;
}) {
  const interactive = input.canManage && input.selected && input.persistedInPool && !input.changing;
  return {
    canSetAvailable: interactive && input.status === "unavailable",
    canSetUnavailable: interactive && input.status === "available"
  };
}

export function attendantPanelState(input: {
  loading: boolean;
  hasData: boolean;
  hasError: boolean;
  count: number;
}): "loading" | "error" | "empty" | "ready" {
  if (input.loading && !input.hasData) return "loading";
  if (input.hasError && !input.hasData) return "error";
  return input.count > 0 ? "ready" : "empty";
}
