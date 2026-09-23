"use client";

/**
 * Lixeira de contatos (R19 v6): lista keyset dos contatos com soft delete,
 * restauração e exclusão definitiva (com confirmação padrão da casa).
 * Página restrita a trash.manage.
 */

import { ArrowClockwise, Trash } from "@/components/icons";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Shell } from "@/components/shell";
import { Badge, Button, EmptyState, IconButton } from "@/components/ui";
import { api } from "@/lib/api";
import { usePermission } from "@/lib/use-permission";
import styles from "./lixeira.module.css";

type TrashedLead = {
  id: string;
  name: string | null;
  phone: string;
  status: string;
  deleted_at: string;
  deleted_by: { id: string; name: string | null } | null;
  created_at: string;
};

type TrashResponse = { items: TrashedLead[]; page: { limit: number; has_more: boolean; next_cursor: string | null } };

const PAGE_SIZE = 30;
const fetcher = <T,>(url: string) => api<T>(url);

const dateFormatter = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : dateFormatter.format(parsed);
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    novo: "Novo",
    em_atendimento: "Em atendimento",
    aguardando_resposta: "Aguardando resposta",
    qualificado: "Qualificado",
    agendado: "Agendado",
    em_negociacao: "Em negociação",
    proposta_enviada: "Proposta enviada",
    follow_up: "Follow-up",
    fechado: "Fechado",
    perdido: "Perdido"
  };
  return map[status] ?? status;
}

export default function TrashPage() {
  const canManage = usePermission("trash.manage");
  const listKey = `/trash?limit=${PAGE_SIZE}`;
  const { data, error, isLoading, mutate } = useSWR<TrashResponse>(canManage ? listKey : null, fetcher, {
    revalidateOnFocus: false
  });
  const [extraItems, setExtraItems] = useState<TrashedLead[]>([]);
  const [pageState, setPageState] = useState<{ cursor: string | null; hasMore: boolean }>({ cursor: null, hasMore: false });
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const page = data?.page;
    if (!page) return;
    setPageState((current) => current.cursor === null && !current.hasMore
      ? { cursor: page.next_cursor, hasMore: page.has_more }
      : current);
  }, [data?.page]);

  const items = useMemo(() => {
    const fresh = data?.items ?? [];
    if (!extraItems.length) return fresh;
    const seen = new Set(fresh.map((item) => item.id));
    const merged = [...fresh];
    for (const item of extraItems) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      }
    }
    return merged;
  }, [data?.items, extraItems]);

  // A lixeira não tem poll: restaurar/excluir remove a linha localmente e
  // revalida a página 1.
  function dropLocal(leadId: string) {
    setExtraItems((current) => current.filter((item) => item.id !== leadId));
    void mutate();
  }

  async function loadMore() {
    if (loadingMore || !pageState.cursor) return;
    setLoadingMore(true);
    setListError("");
    try {
      const response = await api<TrashResponse>(`${listKey}&cursor=${encodeURIComponent(pageState.cursor)}`);
      setExtraItems((current) => {
        const freshIds = new Set((data?.items ?? []).map((item) => item.id));
        const merged = [...current];
        for (const item of response.items) {
          if (![...freshIds, ...merged.map((loaded) => loaded.id)].includes(item.id)) merged.push(item);
        }
        return merged;
      });
      setPageState({ cursor: response.page?.next_cursor ?? null, hasMore: Boolean(response.page?.has_more) });
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : "Falha ao carregar mais itens");
    } finally {
      setLoadingMore(false);
    }
  }

  async function restore(item: TrashedLead) {
    setBusyId(item.id);
    setListError("");
    try {
      await api(`/trash/leads/${item.id}/restore`, { method: "POST" });
      dropLocal(item.id);
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : "Falha ao restaurar o contato");
    } finally {
      setBusyId(null);
    }
  }

  async function destroy(item: TrashedLead) {
    if (!window.confirm(`Excluir definitivamente “${item.name?.trim() || item.phone}”? Esta ação não pode ser desfeita.`)) return;
    setBusyId(item.id);
    setListError("");
    try {
      await api(`/trash/leads/${item.id}`, { method: "DELETE" });
      dropLocal(item.id);
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : "Falha ao excluir definitivamente");
    } finally {
      setBusyId(null);
    }
  }

  if (!canManage) return null;

  return (
    <Shell>
      <div className={styles.page}>
        <header className="pagehead">
          <div>
            <div className="mono mb-3 flex items-center gap-2 type-caption uppercase tracking-[.16em] text-[var(--primary-text)]">Contatos</div>
            <h1>Lixeira</h1>
          </div>
        </header>

        {error ? <p className="error" role="alert">{error.message}</p> : null}
        {listError ? <p className="error" role="alert">{listError}</p> : null}
        {isLoading && !data ? <div className="skeleton h-24" aria-label="Carregando lixeira" /> : null}

        {!isLoading && !items.length ? (
          <EmptyState title="A lixeira está vazia">
            Contatos excluídos pela equipe aparecem aqui e podem ser restaurados.
          </EmptyState>
        ) : null}

        {items.length ? (
          <div className={styles.list}>
            {items.map((item) => (
              <article key={item.id} className={styles.item} data-trash-id={item.id}>
                <div className={styles.itemBody}>
                  <h3 className={styles.itemName}>{item.name?.trim() || "Contato sem nome"}</h3>
                  <div className={styles.itemMeta}>
                    <span>{item.phone}</span>
                    <Badge tone="neutral" variant="pill">{statusLabel(item.status)}</Badge>
                    <span>Excluído em {formatDate(item.deleted_at)}</span>
                    {item.deleted_by ? <span>por {item.deleted_by.name?.trim() || "usuário removido"}</span> : null}
                  </div>
                </div>
                <div className={styles.itemActions}>
                  <IconButton
                    size="sm"
                    label={`Restaurar contato: ${item.name?.trim() || item.phone}`}
                    onClick={() => void restore(item)}
                    disabled={busyId === item.id}
                  >
                    <ArrowClockwise size={14} aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    size="sm"
                    tone="danger"
                    label={`Excluir definitivamente: ${item.name?.trim() || item.phone}`}
                    onClick={() => void destroy(item)}
                    disabled={busyId === item.id}
                  >
                    <Trash size={14} aria-hidden="true" />
                  </IconButton>
                </div>
              </article>
            ))}
            {pageState.hasMore ? (
              <div className="flex justify-center p-3">
                <Button onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "Carregando…" : "Carregar mais"}</Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Shell>
  );
}
