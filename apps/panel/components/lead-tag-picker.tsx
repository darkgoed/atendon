"use client";

import { Check, Tag as TagIcon } from "@/components/icons";
import { useState, type CSSProperties } from "react";
import useSWR from "swr";
import { api } from "@/lib/api";
import { useCaseOrganizationEnabled } from "@/lib/organization";
import { PopoverMenu } from "@/components/popover-menu";
import { usePermission } from "@/lib/use-permission";

export type LeadTag = {
  id: string;
  name: string;
  color: string;
  archived_at?: string | null;
};

type TagsResponse = { tags: LeadTag[] };
const fetcher = <T,>(url: string) => api<T>(url);

const tagItemClassName = "flex min-h-9 items-center gap-2 rounded px-2 text-left text-xs transition-colors hover:bg-[var(--surface-active)] active:scale-[.98] disabled:opacity-50";

/**
 * Conteúdo do seletor de etiquetas (lista de alternância). Exportado para que
 * outras superfícies — como o menu de 3 pontos da linha da tabela de leads —
 * reutilizem a mesma lista sem empilhar um popover dentro de outro.
 */
export function LeadTagMenuItems({
  leadId,
  assigned,
  onChanged
}: {
  leadId: string;
  assigned?: LeadTag[];
  onChanged?: () => unknown | Promise<unknown>;
}) {
  const canApply = usePermission("tags.apply");
  const organizationEnabled = useCaseOrganizationEnabled();
  const { data, error, isLoading } = useSWR<TagsResponse>(canApply && organizationEnabled === true ? "/organization/tags" : null, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 15_000
  });
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const assignedIds = new Set((assigned ?? []).map((tag) => tag.id));

  async function toggle(tag: LeadTag) {
    if (pendingId) return;
    const active = assignedIds.has(tag.id);
    setPendingId(tag.id);
    setActionError("");
    try {
      await api(`/organization/leads/${leadId}/tags/${tag.id}`, { method: active ? "DELETE" : "PUT" });
      await onChanged?.();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Falha ao alterar etiqueta");
    } finally {
      setPendingId(null);
    }
  }

  if (!canApply || organizationEnabled !== true) return null;

  return (
    <>
      {isLoading ? <div className="grid gap-1.5" role="status" aria-label="Carregando etiquetas">{[1, 2, 3].map((item) => <span key={item} className="skeleton h-8" />)}</div> : null}
      {error ? <p className="error p-2" role="alert">{error.message}</p> : null}
      {!isLoading && !error && !data?.tags.length ? <p className="p-2 text-xs text-[var(--text-secondary)]">Nenhuma etiqueta disponível.</p> : null}
      {data?.tags.filter((tag) => !tag.archived_at).map((tag) => {
        const active = assignedIds.has(tag.id);
        return (
          <button
            key={tag.id}
            type="button"
            className={tagItemClassName}
            onClick={() => void toggle(tag)}
            disabled={pendingId != null}
            aria-pressed={active}
          >
            <span className="lead-tag-picker__color" style={{ "--tag-color": tag.color } as CSSProperties} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{tag.name}</span>
            {active ? <Check size={14} weight="bold" aria-label="Aplicada" /> : null}
          </button>
        );
      })}
      {actionError ? <p className="error px-2 py-1" role="alert">{actionError}</p> : null}
    </>
  );
}

export function LeadTagChips({ tags, compact = false, singleLine = false }: { tags?: LeadTag[]; compact?: boolean; singleLine?: boolean }) {
  if (!tags?.length) return null;
  return (
    <span
      className={singleLine ? "lead-tag-chips" : "flex min-w-0 flex-wrap items-center gap-1"}
      role="group"
      aria-label="Etiquetas do lead"
    >
      {tags.map((tag) => (
        <span
          key={tag.id}
          className={`lead-tag-chip ${compact ? "lead-tag-chip--compact" : ""}`}
          style={{ "--tag-color": tag.color } as CSSProperties}
          title={tag.name}
        >
          {tag.name}
        </span>
      ))}
    </span>
  );
}

export function LeadTagPicker({
  leadId,
  assigned,
  onChanged
}: {
  leadId: string;
  assigned?: LeadTag[];
  onChanged?: () => unknown | Promise<unknown>;
}) {
  const canApply = usePermission("tags.apply");
  const organizationEnabled = useCaseOrganizationEnabled();

  if (!canApply || organizationEnabled !== true) return null;

  return (
    <PopoverMenu
      buttonClassName="btn crm-compact-button"
      icon={<TagIcon size={13} aria-hidden="true" />}
      label="Etiquetas"
      panelClassName="pipeline-popover pipeline-popover--tags grid gap-1"
    >
      {() => <LeadTagMenuItems leadId={leadId} assigned={assigned} onChanged={onChanged} />}
    </PopoverMenu>
  );
}
