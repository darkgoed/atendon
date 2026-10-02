"use client";

/**
 * Galeria de mídia do workspace (B10 da spec v7) — lista as mídias
 * armazenadas por origem e permite exclusão em lote, usando os endpoints
 * existentes: GET/DELETE /organization/storage/media. Regras no backend:
 * escopo por tenant, limite de 200 itens por exclusão e mídias de documentos
 * IA (tripz) NÃO são deletáveis — a UI só marca o que o GET diz `deletable`.
 * Permissão exigida pelo backend: storage.manage (o pai decide se renderiza).
 */

import { useState } from "react";
import useSWR from "swr";
import { Empty } from "@/components/page-state";
import { api } from "@/lib/api";
import { formatPanelDateTime } from "@/lib/format";
import { HelpHint } from "@/components/ui";

export type OrganizationStorage = {
  used_bytes: number;
  quota_bytes: number | null;
  retention_days: number | null;
};

/** B/KB/MB/GB/TB em pt-BR; 1 decimal abaixo de 10 da unidade. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  const digits = value < 10 ? 1 : 0;
  return `${value.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[unit]}`;
}

export type StorageMediaItem = {
  id: string;
  type: "sticker" | "follow_up" | "instagram" | "tripz" | "logo";
  deletable: boolean;
  created_at: string;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number;
};

type StorageMediaPage = {
  items: StorageMediaItem[];
  has_more: boolean;
  next_cursor: string | null;
};

const TYPE_LABELS: Record<StorageMediaItem["type"], string> = {
  sticker: "Figurinha da IA",
  follow_up: "Mídia de follow-up",
  instagram: "Mídia do Instagram",
  tripz: "Documento IA",
  logo: "Logo do workspace"
};

const PAGE_SIZE = 30;

export function StorageMediaGallery({ canManage, onChanged }: { canManage: boolean; onChanged?: () => unknown | Promise<unknown> }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [older, setOlder] = useState<StorageMediaPage[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [deletedCount, setDeletedCount] = useState<number | null>(null);

  const firstKey = `/organization/storage/media?limit=${PAGE_SIZE}`;
  const { data, error: loadError, isLoading, mutate } = useSWR<StorageMediaPage>(firstKey, (url: string) => api<StorageMediaPage>(url), {
    revalidateOnFocus: false,
    shouldRetryOnError: false
  });
  /* Observa a MESMA chave do painel de armazenamento (mesmo cache SWR):
     após excluir, o uso/quota do painel revalida junto — sem useSWRConfig,
     que quebra mocks parciais de swr nos testes. */
  const { mutate: mutateStorage } = useSWR<OrganizationStorage>("/organization/storage", (url: string) => api<OrganizationStorage>(url), {
    revalidateOnFocus: false
  });

  const pages: StorageMediaPage[] = data ? [data, ...older] : [];
  const items = pages.flatMap((page) => page.items);
  const nextCursor = pages.length ? pages[pages.length - 1].next_cursor : null;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const response = await api<StorageMediaPage>(`/organization/storage/media?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(nextCursor)}`);
      setOlder((current) => [...current, response]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao carregar mais mídias.");
    } finally {
      setLoadingMore(false);
    }
  }

  async function deleteSelected() {
    if (!canManage || deleting || selected.size === 0) return;
    if (!window.confirm(`Excluir ${selected.size} mídia(s) selecionada(s)? Não há como desfazer.`)) return;
    setDeleting(true);
    setError("");
    setDeletedCount(null);
    try {
      const payload = items
        .filter((item) => selected.has(item.id) && item.deletable)
        .map((item) => ({ type: item.type, id: item.id }));
      const result = await api<{ deleted: number }>("/organization/storage/media", {
        method: "DELETE",
        body: JSON.stringify({ items: payload })
      });
      setSelected(new Set());
      setDeletedCount(result.deleted);
      setOlder([]);
      await mutate();
      await mutateStorage(() => undefined);
      await onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao excluir as mídias.");
    } finally {
      setDeleting(false);
    }
  }

  const deletableSelected = items.filter((item) => selected.has(item.id) && item.deletable).length;

  return (
    <section className="max-w-2xl border-t border-[var(--border)] pt-6" aria-label="Galeria de mídia do workspace">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 flex items-center gap-2 text-base font-semibold text-[var(--text)]">
          Mídias armazenadas
          <HelpHint label="Ajuda: Mídias armazenadas" title="Mídias armazenadas">
            Figurinhas, mídias de follow-up, Instagram e logo usados pelo workspace. Documentos IA aparecem só como registro — nunca são excluídos aqui.
          </HelpHint>
        </h2>
        {canManage && deletableSelected > 0 ? (
          <button type="button" className="btn warn" disabled={deleting} onClick={() => void deleteSelected()}>
            {deleting ? "Excluindo…" : `Excluir ${deletableSelected} selecionada(s)`}
          </button>
        ) : null}
      </div>

      {error ? <p className="error mt-2" role="alert">{error}</p> : null}
      {deletedCount !== null ? <p className="mt-2 text-sm text-[var(--primary-text)]" role="status">{deletedCount} mídia(s) excluída(s).</p> : null}

      {loadError ? (
        <p className="error mt-2" role="alert">{loadError instanceof Error ? loadError.message : "Não foi possível carregar a galeria."}</p>
      ) : isLoading ? (
        <div className="mt-3 grid gap-2" role="status" aria-label="Carregando mídias">
          {[1, 2, 3].map((row) => <div key={row} className="skeleton h-8" aria-hidden="true" />)}
        </div>
      ) : items.length === 0 ? (
        <Empty>Nenhuma mídia armazenada neste workspace.</Empty>
      ) : (
        <>
          <ul className="mt-3 grid gap-1">
            {items.map((item) => (
              <li className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border)] px-3 py-1.5 text-sm" key={`${item.type}:${item.id}`}>
                {item.deletable && canManage ? (
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => toggle(item.id)}
                    aria-label={`Selecionar ${TYPE_LABELS[item.type]} de ${formatPanelDateTime(item.created_at)}`}
                  />
                ) : null}
                <span className="min-w-0 flex-1">
                  <strong>{TYPE_LABELS[item.type]}</strong>
                  {item.file_name ? <span className="mono block truncate text-xs text-[var(--text-secondary)]">{item.file_name}</span> : null}
                </span>
                <span className="mono shrink-0 text-xs text-[var(--text-muted)]">{formatBytes(item.size_bytes)}</span>
                <time className="mono shrink-0 text-xs">{formatPanelDateTime(item.created_at)}</time>
                {!item.deletable ? <span className="mono shrink-0 text-xs text-[var(--text-muted)]">não removível</span> : null}
              </li>
            ))}
          </ul>
          {nextCursor ? (
            <div className="mt-3 flex justify-center">
              <button type="button" className="btn" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? "Carregando…" : "Carregar mais mídias"}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
