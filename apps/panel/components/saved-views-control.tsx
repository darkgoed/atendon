"use client";

import { BookmarkSimple, FloppyDisk, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import useSWR from "swr";
import { api } from "@/lib/api";
import { useCaseOrganizationEnabled } from "@/lib/organization";
import { PopoverMenu } from "@/components/popover-menu";
import { Input, SaveButton, SaveToast, useSaveFeedback } from "@/components/ui";
import type { PanelSession } from "@/lib/session";
import { usePermission } from "@/lib/use-permission";

type SavedViewResource = "conversations" | "leads" | "pipeline";
type SavedView = {
  id: string;
  name: string;
  resource: SavedViewResource;
  filters: Record<string, unknown>;
  shared: boolean;
  owner_user_id: string;
};

const fetcher = <T,>(url: string) => api<T>(url);

export function SavedViewsControl({
  resource,
  filters,
  onApply
}: {
  resource: SavedViewResource;
  filters: Record<string, unknown>;
  onApply: (filters: Record<string, unknown>) => void;
}) {
  const canPublish = usePermission("saved_views.publish");
  const organizationEnabled = useCaseOrganizationEnabled();
  const { data: session } = useSWR<PanelSession>("/me", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 10_000
  });
  const { data, error, isLoading, mutate } = useSWR<{ saved_views: SavedView[] }>(
    organizationEnabled === true ? `/organization/saved-views?resource=${resource}` : null,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 10_000 }
  );
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const viewSave = useSaveFeedback();

  async function save() {
    if (!name.trim() || pending) return;
    setPending(true);
    setActionError("");
    try {
      await api("/organization/saved-views", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), resource, filters, shared: canPublish && shared })
      });
      setName("");
      setShared(false);
      await mutate();
      viewSave.markDone();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Falha ao salvar visão");
    } finally {
      setPending(false);
    }
  }

  async function remove(view: SavedView) {
    if (pending || !window.confirm(`Excluir a visão “${view.name}”?`)) return;
    setPending(true);
    setActionError("");
    try {
      await api(`/organization/saved-views/${view.id}`, { method: "DELETE" });
      await mutate();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Falha ao excluir visão");
    } finally {
      setPending(false);
    }
  }

  if (organizationEnabled !== true) return null;
  return (
    <PopoverMenu
      buttonClassName="icon-button icon-button--md"
      icon={<BookmarkSimple size={16} aria-hidden="true" />}
      ariaLabel="Visões"
      title="Visões"
      panelClassName="pipeline-popover pipeline-popover--saved grid gap-3"
    >
      {(close) => (
        <>
          <div>
            <strong className="text-xs">Visões salvas</strong>
            <p className="pipeline-preference-copy">Aplique um conjunto de filtros ou salve a configuração atual.</p>
          </div>
          <div className="grid max-h-52 gap-1 overflow-y-auto">
            {isLoading ? <div className="grid gap-1.5" role="status" aria-label="Carregando visões">{[1, 2].map((item) => <span key={item} className="skeleton h-9" />)}</div> : null}
            {error ? <p className="error" role="alert">{error.message}</p> : null}
            {!isLoading && !error && !data?.saved_views.length ? <p className="py-2 text-xs text-[var(--text-secondary)]">Nenhuma visão salva.</p> : null}
            {data?.saved_views.map((view) => (
              <div key={view.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 rounded border border-[var(--border)] p-1">
                <button type="button" className="min-w-0 rounded px-2 py-1.5 text-left active:scale-[.98]" onClick={() => { onApply(view.filters); close(); }}>
                  <span className="block truncate text-xs font-medium">{view.name}</span>
                  <span className="crm-caption">{view.shared ? "Compartilhada" : "Pessoal"}</span>
                </button>
                {canPublish || view.owner_user_id === session?.user.id ? (
                  <button type="button" className="grid size-8 place-items-center rounded text-[var(--text-muted)] hover:bg-[var(--surface-active)] hover:text-[var(--warning-text)] active:scale-[.94]" onClick={() => void remove(view)} aria-label={`Excluir visão ${view.name}`} disabled={pending}>
                    <Trash size={14} aria-hidden="true" />
                  </button>
                ) : <span className="size-8" aria-hidden="true" />}
              </div>
            ))}
          </div>
          <div className="grid gap-2 border-t border-[var(--border)] pt-3">
            <label className="field">
              <span className="label">Nome da visão</span>
              <Input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="Ex.: Leads quentes desta semana" />
            </label>
            {canPublish ? <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} /> Compartilhar com o workspace</label> : null}
            <SaveButton state={pending ? "busy" : viewSave.state} icon={<FloppyDisk size={15} aria-hidden="true" />} onClick={() => void save()} disabled={!name.trim() || pending}>
              Salvar filtros atuais
            </SaveButton>
            {actionError ? <p className="error" role="alert">{actionError}</p> : null}
            <SaveToast show={viewSave.done}>Visão salva</SaveToast>
          </div>
        </>
      )}
    </PopoverMenu>
  );
}
