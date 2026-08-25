"use client";

import { Check, Tag as TagIcon } from "@phosphor-icons/react";
import { useState } from "react";
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

export function LeadTagChips({ tags, compact = false }: { tags?: LeadTag[]; compact?: boolean }) {
  if (!tags?.length) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1" role="group" aria-label="Etiquetas do lead">
      {tags.map((tag) => (
        <span
          key={tag.id}
          className={`inline-flex max-w-32 items-center truncate rounded-sm border px-1.5 ${compact ? "py-0 text-[9px]" : "py-0.5 text-[10px]"}`}
          style={{ borderColor: tag.color, color: tag.color }}
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
    <PopoverMenu
      buttonClassName="btn min-h-7 px-2 py-1 text-[10px] active:scale-[.98]"
      icon={<TagIcon size={13} aria-hidden="true" />}
      label="Etiquetas"
      panelClassName="grid w-[min(256px,calc(100vw-32px))] gap-1 rounded border border-[var(--border)] bg-[var(--dialog)] p-2 shadow-[0_16px_36px_color-mix(in_srgb,var(--app)_34%,transparent)]"
    >
      {() => (
        <>
          {isLoading ? <div className="grid gap-1.5" role="status" aria-label="Carregando etiquetas">{[1, 2, 3].map((item) => <span key={item} className="skeleton h-8" />)}</div> : null}
          {error ? <p className="error p-2" role="alert">{error.message}</p> : null}
          {!isLoading && !error && !data?.tags.length ? <p className="p-2 text-xs text-[var(--muted)]">Nenhuma etiqueta disponível.</p> : null}
          {data?.tags.filter((tag) => !tag.archived_at).map((tag) => {
            const active = assignedIds.has(tag.id);
            return (
              <button
                key={tag.id}
                type="button"
                className="flex min-h-9 items-center gap-2 rounded px-2 text-left text-xs transition-colors hover:bg-[var(--active)] active:scale-[.98] disabled:opacity-50"
                onClick={() => void toggle(tag)}
                disabled={pendingId != null}
                aria-pressed={active}
              >
                <span className="size-2.5 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                {active ? <Check size={14} weight="bold" aria-label="Aplicada" /> : null}
              </button>
            );
          })}
          {actionError ? <p className="error px-2 py-1" role="alert">{actionError}</p> : null}
        </>
      )}
    </PopoverMenu>
  );
}
