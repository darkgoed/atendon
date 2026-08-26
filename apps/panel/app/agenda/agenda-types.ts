export type Unit = { id: string; nome: string };

export type Slot = {
  start: string;
  end: string;
  vagas: number;
  capacidade: number;
  ocupados_no_inicio?: number;
};

export type AppointmentStatus = "confirmado" | "reagendado" | "cancelado" | "concluido" | "no_show";

export type Appointment = {
  id: string;
  lead_id: string;
  start: string;
  end: string;
  status: AppointmentStatus;
  lead_nome?: string;
  lead_telefone: string;
  conversation_id?: string | null;
  meet_link?: string | null;
  meeting_provider?: "google_meet" | "atendon_meet" | null;
  meeting_url?: string | null;
  observacao?: string | null;
  atualizado_em: string;
  result_pending?: boolean;
  result_pending_at?: string | null;
  responsavel?: {
    member_id: string;
    user_id: string | null;
    email: string | null;
    availability_status: "available" | "unavailable" | null;
    cor_agenda?: string | null;
  } | null;
};

export type AppointmentLead = { id: string; nome?: string; telefone: string };
export type FinalAction = "cancel" | "complete" | "no_show";
export type AppointmentView = "all" | "active" | "pending" | "finished";
export type AvailabilityResponse = { data: string; timezone: string; horarios: Slot[] };
export type AppointmentsResponse = { agendamentos: Appointment[]; timezone: string };
export type AttendantTimeBlock = {
  id: string;
  member_id: string;
  start: string;
  end: string;
  reason: string | null;
  created_at: string;
};
export type AttendantTimeBlocksResponse = { blocks: AttendantTimeBlock[] };
export type RecurringTimeBlock = {
  id: string; member_id: string; start_local_time: string; end_local_time: string;
  weekdays: number[]; starts_on: string; ends_on?: string | null; timezone: string;
  reason: string; active: boolean;
};

export type AppointmentAssignee = {
  member_id: string;
  user_id: string;
  name: string | null;
  email: string;
  online: boolean;
  availability_status: "available" | "unavailable";
  future_meetings_count: number;
  conflicts: Array<{ id: string; start: string; end: string; lead_name: string | null }>;
  selectable: boolean;
  suggested: boolean;
};

export type AppointmentAssigneesResponse = {
  assignees: AppointmentAssignee[];
  can_select_assignee: boolean;
  suggested_member_id: string | null;
};

export type LoadStatus = "idle" | "loading" | "ready" | "error";
export type AvailabilityState = {
  status: LoadStatus;
  slots: Record<string, Slot[]>;
  timezone: string;
  error: string;
  failedDays: string[];
  loadedDays: string[];
  unitId: string;
};

export type AgendaPermissions = {
  canReschedule: boolean;
  canCreate: boolean;
  canCancel: boolean;
  canComplete: boolean;
  canNoShow: boolean;
  canManageNotes: boolean;
  canCreateLeads: boolean;
  canReply: boolean;
  canDeleteLead: boolean;
};
