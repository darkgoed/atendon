"use client";

// R9/R10 — Fonte de eventos do lead. Uma única tabela no backend, duas visões:
// timeline completa (R9) e atividades compactas (R10). Os endpoints ainda são
// contratos pendentes do worker backend (W2B): GET
// /scheduling/leads/:id/timeline e /scheduling/leads/:id/activities, shape
// { items: [{ type, at, actor, detail }], page }. 404 → seção vazia (o backend
// pode integrar depois sem mudança de UI).

import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import { api, ApiError } from "./api";

export type LeadEventSource = "ai" | "robot" | "human";

export type LeadTimelineEvent = {
  type: string;
  at: string;
  actor?: string | null;
  detail?: string | Record<string, unknown> | null;
};

export type LeadEventPage = { next_cursor: string | null; has_more: boolean };

export type LeadEventListResponse = {
  items: LeadTimelineEvent[];
  page?: LeadEventPage | null;
};

export type LeadEventKind = "timeline" | "activities";

export const LEAD_HISTORY_PAGE_SIZE = 20;

export function leadTimelineUrl(leadId: string, cursor?: string | null): string {
  const query = cursor
    ? `?cursor=${encodeURIComponent(cursor)}&limit=${LEAD_HISTORY_PAGE_SIZE}`
    : `?limit=${LEAD_HISTORY_PAGE_SIZE}`;
  return `/scheduling/leads/${leadId}/timeline${query}`;
}

export function leadActivitiesUrl(leadId: string, cursor?: string | null): string {
  const query = cursor
    ? `?cursor=${encodeURIComponent(cursor)}&limit=${LEAD_HISTORY_PAGE_SIZE}`
    : `?limit=${LEAD_HISTORY_PAGE_SIZE}`;
  return `/scheduling/leads/${leadId}/activities${query}`;
}

/**
 * Timeline: contrato principal. Atividades: a spec permite o endpoint dedicado
 * OU `?view=activities` na mesma API da timeline — tenta o dedicado e cai para
 * o alternativo em 404 (qualquer dos dois 404 propaga e a UI mostra vazio).
 */
export async function fetchLeadEvents(kind: LeadEventKind, leadId: string, cursor?: string | null): Promise<LeadEventListResponse> {
  if (kind === "timeline") return api<LeadEventListResponse>(leadTimelineUrl(leadId, cursor));
  try {
    return await api<LeadEventListResponse>(leadActivitiesUrl(leadId, cursor));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return await api<LeadEventListResponse>(`${leadTimelineUrl(leadId, cursor)}&view=activities`);
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Classificação: fonte (IA vs robô vs humano) e grupo narrativo       */
/* ------------------------------------------------------------------ */

export const LEAD_EVENT_SOURCE_LABELS: Record<LeadEventSource, string> = {
  ai: "IA",
  robot: "Robô",
  human: "Humano"
};

const AI_ACTOR = /^(ia|ai|assistente ia|agente ia|atendon ia)$/;
const ROBOT_ACTOR = /^(robo|robô|bot|sistema|system|automation|automa(ç|c)(ã|a)o)$/;

/**
 * Fonte declarada no detail (`detail.source`) vence; senão o prefixo do type
 * (ai.*, robot.*, flow.*) decide; senão o ator; sem ator → automático (robô).
 */
export function leadEventSource(event: LeadTimelineEvent): LeadEventSource {
  const type = (event.type ?? "").toLowerCase();
  const detail = event.detail && typeof event.detail === "object" ? (event.detail as Record<string, unknown>) : {};
  const declared = typeof detail.source === "string" ? detail.source.trim().toLowerCase() : "";
  if (declared === "ai" || declared === "ia") return "ai";
  if (declared === "robot" || declared === "robo" || declared === "robô" || declared === "bot") return "robot";
  if (declared === "human" || declared === "humano") return "human";
  if (type.startsWith("ai.") || type.startsWith("ia.")) return "ai";
  if (type.startsWith("robot.") || type.startsWith("flow.") || type.startsWith("robo.")) return "robot";
  const actor = (event.actor ?? "").trim().toLowerCase();
  if (!actor) return "robot";
  if (AI_ACTOR.test(actor)) return "ai";
  if (ROBOT_ACTOR.test(actor)) return "robot";
  return "human";
}

export type LeadEventGroup =
  | "origin"
  | "qualification"
  | "tags"
  | "pipeline"
  | "responsible"
  | "transfer"
  | "appointment"
  | "note"
  | "closing"
  | "other";

export const LEAD_EVENT_GROUP_LABELS: Record<LeadEventGroup, string> = {
  origin: "Origem e criação",
  qualification: "Qualificações",
  tags: "Tags",
  pipeline: "Pipeline e etapas",
  responsible: "Responsáveis",
  transfer: "Transferências",
  appointment: "Agendamentos",
  note: "Observações",
  closing: "Encerramento, venda e perda",
  other: "Outros eventos"
};

/** Ordem narrativa: como entrou → o que aconteceu → como saiu. */
export const LEAD_EVENT_GROUP_ORDER: LeadEventGroup[] = [
  "origin",
  "qualification",
  "tags",
  "pipeline",
  "responsible",
  "transfer",
  "appointment",
  "note",
  "closing",
  "other"
];

export function leadEventGroup(type: string): LeadEventGroup {
  const value = (type ?? "").toLowerCase();
  if (/(clos|encerr|venda|sale|won|win\b|perd|lost|fechad)/.test(value)) return "closing";
  if (/qualif/.test(value)) return "qualification";
  // \b obrigatório: "stage.changed" contém a sequência "tag" (s-TAG-e) e só
  // cai em "pipeline" se a fronteira de palavra separar tag real de stage.
  if (/\b(tag|etiqueta)/.test(value)) return "tags";
  if (/(transfer|handoff|fila_humana|fila humana)/.test(value)) return "transfer";
  // responsib (contrato em inglês "responsible.*") e responsab (pt: responsável).
  if (/(responsab|responsib|assign|owner|sdr|closer)/.test(value)) return "responsible";
  if (/(appoint|agend|schedul|reagend|reuni)/.test(value)) return "appointment";
  if (/(pipeline|stage|etapa|status|funnel)/.test(value)) return "pipeline";
  if (/(nota|note|coment|observa)/.test(value)) return "note";
  if (/(cria|creat|origem|origin|source|campanha|campaign|import)/.test(value)) return "origin";
  return "other";
}

/** Rótulos pt-BR dos types conhecidos; type desconhecido cai no humanize. */
const LEAD_EVENT_TYPE_LABELS: Record<string, string> = {
  "lead.created": "Lead criado",
  "lead.updated": "Lead atualizado",
  "lead.imported": "Contato importado",
  "lead.closed.won": "Venda concluída",
  "lead.closed.lost": "Lead perdido",
  "lead.closed": "Lead encerrado",
  "qualification.created": "Qualificação criada",
  "qualification.updated": "Qualificação atualizada",
  "ai.qualification": "Qualificação por IA",
  "tag.added": "Tag adicionada",
  "tag.removed": "Tag removida",
  "transfer.requested": "Transferência para atendimento humano",
  "transfer.completed": "Transferência concluída",
  "responsible.changed": "Responsável alterado",
  "appointment.created": "Agendamento criado",
  "appointment.rescheduled": "Agendamento reagendado",
  "appointment.canceled": "Agendamento cancelado",
  "appointment.concluded": "Agendamento concluído",
  "stage.changed": "Etapa alterada",
  "status.updated": "Status atualizado",
  "note.added": "Observação adicionada",
  "flow.step": "Etapa do robô"
};

const TITLE_STOPWORDS = new Set(["de", "da", "do", "para", "em", "com", "por"]);

/** Título legível do evento: dicionário pt-BR primeiro, humanize como fallback. */
export function leadEventTitle(type: string): string {
  const value = (type ?? "").trim();
  if (!value) return "Evento";
  const known = LEAD_EVENT_TYPE_LABELS[value.toLowerCase()];
  if (known) return known;
  const words = value.split(/[._\-:]+/).filter(Boolean);
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index > 0 && TITLE_STOPWORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

const DETAIL_PREFERRED_KEYS = ["descricao", "description", "message", "resumo", "texto", "detail", "observacao", "motivo", "resultado"];

/** Descrição legível: string direta, chave preferida do objeto ou pares resumidos. */
export function leadEventDetail(detail: LeadTimelineEvent["detail"]): string {
  if (typeof detail === "string") return detail;
  if (!detail || typeof detail !== "object") return "";
  const record = detail as Record<string, unknown>;
  for (const key of DETAIL_PREFERRED_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value == null || typeof value === "object") continue;
    parts.push(`${key}: ${String(value)}`);
    if (parts.length === 3) break;
  }
  return parts.join(" · ");
}

/** Ator legível: sem ator → "Sistema". */
export function leadEventActor(actor: LeadTimelineEvent["actor"]): string {
  const trimmed = (actor ?? "").trim();
  return trimmed || "Sistema";
}

/**
 * Tempo relativo pt-BR sem Intl.RelativeTimeFormat (Safari < 14.1): agora,
 * há X min, há X h, ontem, há X dias/meses/anos. Futuro (skew de relógio) →
 * "agora".
 */
export function relativeEventTime(at: string, now: number = Date.now()): string {
  const timestamp = Date.parse(at);
  if (Number.isNaN(timestamp)) return "";
  const diffMs = Math.max(0, now - timestamp);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "ontem";
  if (days < 30) return `há ${days} dias`;
  const months = Math.floor(days / 30);
  if (months < 12) return `há ${months} ${months === 1 ? "mês" : "meses"}`;
  const years = Math.floor(days / 365);
  return `há ${years} ${years === 1 ? "ano" : "anos"}`;
}

/* ------------------------------------------------------------------ */
/* Agrupamento e paginação                                             */
/* ------------------------------------------------------------------ */

export type LeadEventGroupSection = { group: LeadEventGroup; events: LeadTimelineEvent[] };

/** Agrupa preservando a ordem dos grupos e a ordem cronológica desc dentro de cada um. */
export function groupLeadEvents(events: LeadTimelineEvent[]): LeadEventGroupSection[] {
  const buckets = new Map<LeadEventGroup, LeadTimelineEvent[]>();
  for (const event of events) {
    const group = leadEventGroup(event.type ?? "");
    const bucket = buckets.get(group);
    if (bucket) bucket.push(event);
    else buckets.set(group, [event]);
  }
  const sections: LeadEventGroupSection[] = [];
  for (const group of LEAD_EVENT_GROUP_ORDER) {
    const bucket = buckets.get(group);
    if (!bucket?.length) continue;
    const sorted = [...bucket].sort((a, b) => {
      const left = Date.parse(a.at ?? "");
      const right = Date.parse(b.at ?? "");
      if (Number.isNaN(left) && Number.isNaN(right)) return 0;
      if (Number.isNaN(left)) return 1;
      if (Number.isNaN(right)) return -1;
      return right - left;
    });
    sections.push({ group, events: sorted });
  }
  return sections;
}

function eventKey(event: LeadTimelineEvent): string {
  const detail = typeof event.detail === "object" && event.detail !== null ? JSON.stringify(event.detail) : String(event.detail ?? "");
  return `${event.type ?? ""}|${event.at ?? ""}|${event.actor ?? ""}|${detail}`;
}

/** Anexa a página mais antiga deduplicando contra o que já está carregado. */
export function appendEventPage(current: LeadTimelineEvent[], incoming: LeadTimelineEvent[]): LeadTimelineEvent[] {
  const seen = new Set(current.map(eventKey));
  const fresh = incoming.filter((event) => !seen.has(eventKey(event)));
  return fresh.length ? [...current, ...fresh] : current;
}

/* ------------------------------------------------------------------ */
/* Hook de listagem paginada (keyset + "Carregar mais")                */
/* ------------------------------------------------------------------ */

export type UseLeadEventsResult = {
  items: LeadTimelineEvent[];
  loading: boolean;
  /** 404 dos dois caminhos (ou da timeline): seção vazia, não erro. */
  notFound: boolean;
  error: string;
  canLoadMore: boolean;
  loadingMore: boolean;
  loadMoreError: string;
  loadMore: () => void;
  reload: () => void;
};

export function useLeadEvents(kind: LeadEventKind, leadId: string, enabled: boolean): UseLeadEventsResult {
  const cacheKey = enabled ? `lead-events:v1:${kind}:${leadId}` : null;
  const { data, error, isLoading, mutate } = useSWR<LeadEventListResponse>(cacheKey, () => fetchLeadEvents(kind, leadId), {
    revalidateOnFocus: false
  });

  const [older, setOlder] = useState<LeadTimelineEvent[]>([]);
  const [pageState, setPageState] = useState<{ cursor: string | null; hasMore: boolean; fetchedPages: number }>({
    cursor: null,
    hasMore: false,
    fetchedPages: 0
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState("");

  // Nova chave (troca de lead/visão) zera as páginas extras e o cursor-âncora,
  // espelhando o padrão da lista de contatos: o poll da primeira página não
  // pode sobrescrever o cursor quando páginas mais antigas já foram carregadas.
  useEffect(() => {
    setOlder([]);
    setPageState({ cursor: null, hasMore: false, fetchedPages: 0 });
    setLoadMoreError("");
  }, [cacheKey]);

  useEffect(() => {
    const page = data?.page;
    if (!page || pageState.fetchedPages > 0) return;
    setPageState((current) =>
      current.fetchedPages > 0
        ? current
        : { cursor: page.next_cursor ?? null, hasMore: Boolean(page.has_more), fetchedPages: 0 }
    );
  }, [data?.page, pageState.fetchedPages]);

  // Merge da primeira página (SWR) com as páginas mais antigas carregadas
  // por "Carregar mais" (appendEventPage deduplica contra a primeira página;
  // sem isso a página extra era gravada em estado morto e nunca exibida).
  const items = appendEventPage(data?.items ?? [], older);
  const loadMore = useCallback(() => {
    if (!pageState.cursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError("");
    fetchLeadEvents(kind, leadId, pageState.cursor)
      .then((response) => {
        setOlder((current) => appendEventPage(current, response.items ?? []));
        setPageState((current) => ({
          cursor: response.page?.next_cursor ?? null,
          hasMore: Boolean(response.page?.has_more),
          fetchedPages: current.fetchedPages + 1
        }));
      })
      .catch((loadError) => {
        setLoadMoreError(loadError instanceof Error ? loadError.message : "Falha ao carregar mais eventos");
      })
      .finally(() => setLoadingMore(false));
  }, [kind, leadId, loadingMore, pageState.cursor]);

  const reload = useCallback(() => {
    setOlder([]);
    setPageState({ cursor: null, hasMore: false, fetchedPages: 0 });
    void mutate();
  }, [mutate]);

  const notFound = error instanceof ApiError && error.status === 404;
  const message = error && !notFound ? (error instanceof Error ? error.message : "Falha ao carregar os eventos") : "";

  return {
    items,
    loading: Boolean(cacheKey) && isLoading,
    notFound,
    error: message,
    canLoadMore: pageState.hasMore,
    loadingMore,
    loadMoreError,
    loadMore,
    reload
  };
}
