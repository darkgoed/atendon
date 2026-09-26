// Adoção de mudanças originadas no GOOGLE → AtendON (inbound) para eventos
// já vinculados a um agendamento (specs/active/google-calendar-team-sync).
// A decisão é derivada do evento lido do Google pelo worker; AQUI não há
// chamada ao Google nem UPDATE direto: toda escrita passa pelos serviços de
// domínio existentes (rescheduleAppointment / cancelAppointment), que mantêm
// capacidade, freeBusy, jornada comercial e o enfileiramento do gatilho 0189.
// O snapshot local lido ANTES da leitura do Google vira guarda de concorrência
// (expectedSnapshot → 409 sob lock FOR UPDATE se outra operação editou antes).
import type { GoogleCalendarEvent } from "./google-calendar.js";
import { cancelAppointment, rescheduleAppointment, type AppointmentStatus } from "./service.js";

// Apenas linhas ativas aceitam adoção: cancelado/concluido/no_show já foram
// resolvidos pela jornada — nada do Google pode reabri-los aqui.
const ADOPTABLE_STATUSES: ReadonlySet<AppointmentStatus> = new Set(["confirmado", "reagendado"]);

export type LocalAppointmentSnapshot = {
  status: AppointmentStatus;
  startAt: string;
  endAt: string;
};

export type AdoptGoogleCalendarChangeInput = {
  tenantId: string;
  appointmentId: string;
  localSnapshot: LocalAppointmentSnapshot;
  event?: GoogleCalendarEvent | null;
  /** Google respondeu 404/410: evento removido (getEvent lança GoogleCalendarApiError com status 404/410). */
  notFound?: boolean;
  now?: Date;
};

export type AdoptGoogleCalendarChangeResult =
  | { kind: "adopted"; action: "moved" | "cancelled"; appointment: Awaited<ReturnType<typeof rescheduleAppointment>> }
  | { kind: "unchanged"; reason: string }
  | { kind: "conflict"; reason: string };

const conflict = (reason: string): AdoptGoogleCalendarChangeResult => ({ kind: "conflict", reason });

function expectedSnapshot(snapshot: LocalAppointmentSnapshot) {
  return { status: snapshot.status, start_at: snapshot.startAt, end_at: snapshot.endAt };
}

// Recusa esperada do domínio (guarda de snapshot, capacidade, busy do Google,
// intervalo manual) → conflito para o worker reler e reaplicar. Erros de rede,
// Google indisponível (502/503) e 404/500 de integridade propagam.
function expectedDomainConflict(error: unknown): AdoptGoogleCalendarChangeResult | null {
  const status = error && typeof error === "object" && "statusCode" in error
    ? Number((error as { statusCode?: unknown }).statusCode)
    : undefined;
  if (status !== 409 && status !== 400) return null;
  return conflict(error instanceof Error ? error.message : "Conflito na adoção da mudança do Google Calendar");
}

export async function adoptGoogleCalendarChange(
  input: AdoptGoogleCalendarChangeInput
): Promise<AdoptGoogleCalendarChangeResult> {
  if (!ADOPTABLE_STATUSES.has(input.localSnapshot.status)) {
    return { kind: "unchanged", reason: `Agendamento local ${input.localSnapshot.status} não é ativo para adoção` };
  }
  const event = input.event ?? null;
  const snapshot = expectedSnapshot(input.localSnapshot);
  const actor = { userId: null };

  // Cancelado no Google ou removido (404/410): cancela com a disposição segura
  // existente (recover + próxima ação) e guarda de snapshot.
  if (input.notFound === true || event?.status === "cancelled") {
    try {
      const appointment = await cancelAppointment(input.tenantId, input.appointmentId, undefined, actor, undefined, { expectedSnapshot: snapshot });
      return { kind: "adopted", action: "cancelled", appointment };
    } catch (error) {
      const mapped = expectedDomainConflict(error);
      if (mapped) return mapped;
      throw error;
    }
  }

  // Só evento datado (RFC 3339 dateTime com offset): dia inteiro (date) não tem
  // horário para encaixar na grade.
  const startRaw = event?.start?.dateTime;
  const endRaw = event?.end?.dateTime;
  if (!startRaw || !endRaw) {
    return conflict("Evento do Google não é datado (dia inteiro ou sem horário)");
  }
  const start = new Date(startRaw);
  const end = new Date(endRaw);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return conflict("Evento do Google com horário inválido");
  }
  const now = input.now ?? new Date();
  // Já em sincronia: mutação inócua — não reescreve nem reenfileira.
  if (start.getTime() === Date.parse(input.localSnapshot.startAt) && end.getTime() === Date.parse(input.localSnapshot.endAt)) {
    return { kind: "unchanged", reason: "Evento do Google já coincide com o agendamento local" };
  }
  // Evento movido precisa ser futuro: qualquer data futura é adotada (sem
  // horizonte máximo). O teto de duração (24h) continua no domínio
  // (validateManualAppointmentInterval) e recusa como conflito.
  if (start.getTime() <= now.getTime()) {
    return conflict("Evento do Google foi movido para o passado");
  }
  try {
    // manual:true mantém o intervalo exato do Google (instante ISO → UTC;
    // duração preservada); unidade do agendamento é preservada. Capacidade,
    // freeBusy e jornada comercial rodam dentro do serviço existente.
    const appointment = await rescheduleAppointment(
      input.tenantId,
      input.appointmentId,
      { start: start.toISOString(), end: end.toISOString() },
      { manual: true, now, expectedSnapshot: snapshot, actor }
    );
    return { kind: "adopted", action: "moved", appointment };
  } catch (error) {
    const mapped = expectedDomainConflict(error);
    if (mapped) return mapped;
    throw error;
  }
}
