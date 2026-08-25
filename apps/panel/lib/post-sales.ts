import { ApiError } from "./api";
import { formatBrazilianPhone } from "./phone";

export type PostSaleChecklistResult = "pendente" | "oferecido" | "aceito" | "recusado" | "nao_se_aplica";
export type PostSaleState = "not_started" | "in_progress" | "checklist_complete" | "action_overdue" | "archived";
export type PostSaleNextActionQueue = "none" | "overdue" | "today" | "upcoming";

export type PostSaleClient = {
  id: string;
  name: string;
  phone_e164: string;
  email: string | null;
  notes: string | null;
  responsible_member_id: string | null;
  responsible_name: string | null;
  responsible_email: string | null;
  next_action: string | null;
  next_action_at: string | null;
  next_action_queue: PostSaleNextActionQueue;
  origin: "manual" | "closed_sale";
  lead_id: string | null;
  conversation_id?: string | null;
  archived_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  checklist_total: number;
  checklist_completed: number;
  checklist_accepted: number;
  progress_percent: number;
  state: PostSaleState;
};

export type PostSaleChecklistEntry = {
  id: string;
  item_id: string;
  description: string;
  position: number;
  is_active: boolean;
  item_archived_at: string | null;
  item_version: number;
  result: PostSaleChecklistResult;
  note: string | null;
  version: number;
  updated_at: string;
  updated_by_name: string | null;
};

export type PostSaleSummary = {
  active: number;
  archived: number;
  not_started: number;
  in_progress: number;
  complete: number;
  overdue: number;
  today: number;
  upcoming: number;
};

export type PostSaleMember = {
  id: string;
  user_id: string;
  name: string;
  email: string;
};

export type PostSaleTemplateItem = {
  id: string;
  description: string;
  position: number;
  is_active: boolean;
  archived_at: string | null;
  version: number;
  client_count: number;
  answered_count: number;
};

export type PostSaleFilters = {
  q: string;
  progress: "" | "not_started" | "in_progress" | "complete";
  responsible_member_id: string;
  next_action: "" | "overdue" | "today" | "upcoming" | "none";
  archived: "active" | "archived" | "all";
};

export const EMPTY_POST_SALE_FILTERS: PostSaleFilters = {
  q: "",
  progress: "",
  responsible_member_id: "",
  next_action: "",
  archived: "active"
};

export const checklistResultOptions: Array<{ value: PostSaleChecklistResult; label: string }> = [
  { value: "pendente", label: "Pendente" },
  { value: "oferecido", label: "Oferecido" },
  { value: "aceito", label: "Aceito" },
  { value: "recusado", label: "Recusado" },
  { value: "nao_se_aplica", label: "Não se aplica" }
];

export function postSaleStateLabel(state: PostSaleState) {
  return ({
    not_started: "Não iniciado",
    in_progress: "Em andamento",
    checklist_complete: "Checklist completo",
    action_overdue: "Ação atrasada",
    archived: "Arquivado"
  } as const)[state];
}

export function postSaleQueueLabel(queue: PostSaleNextActionQueue) {
  return ({ none: "Sem ação", overdue: "Atrasada", today: "Hoje", upcoming: "Próxima" } as const)[queue];
}

export function postSaleOriginLabel(origin: PostSaleClient["origin"]) {
  return origin === "closed_sale" ? "Venda fechada" : "Cadastro manual";
}

export function formatPostSalePhone(phone: string) {
  if (phone.startsWith("55") && (phone.length === 12 || phone.length === 13)) {
    return `+55 ${formatBrazilianPhone(phone.slice(2))}`;
  }
  return `+${phone}`;
}

export function buildPostSaleQuery(filters: PostSaleFilters) {
  const query = new URLSearchParams();
  const search = filters.q.trim();
  if (search) query.set("q", search);
  if (filters.progress) query.set("progress", filters.progress);
  if (filters.responsible_member_id) query.set("responsible_member_id", filters.responsible_member_id);
  if (filters.next_action) query.set("next_action", filters.next_action);
  query.set("archived", filters.archived);
  return query.toString();
}

export function isPostSaleVersionConflict(error: unknown) {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  if (!error.body || typeof error.body !== "object") return false;
  return (error.body as { code?: unknown }).code === "VERSION_CONFLICT";
}
