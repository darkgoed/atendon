"use client";

import { Check, FileText, PencilSimple, Plus, Trash, X } from "@phosphor-icons/react";
import React, { useEffect, useRef, useState } from "react";
import {
  formatTripzTimestamp,
  tripzConversationStatusLabel,
  type TripzConversation
} from "../../lib/tripz-ai";

function StatusMark({ status }: { status: TripzConversation["status"] }) {
  const ready = status === "ready_for_review" || status === "ready_for_pdf";
  const generated = status === "pdf_generated";
  return (
    <span
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${generated ? "bg-[var(--ok)]" : ready ? "bg-[var(--accent)]" : "bg-[var(--faint)]"}`}
      aria-hidden="true"
    />
  );
}

export function TripzHistorySidebar({
  conversations,
  selectedId,
  loading,
  creating,
  loadingMore,
  renamingId,
  hasMore,
  mobileOpen,
  onCloseMobile,
  onCreate,
  onSelect,
  onDelete,
  onRename,
  onLoadMore
}: {
  conversations: TripzConversation[];
  selectedId: string | null;
  loading: boolean;
  creating: boolean;
  loadingMore: boolean;
  renamingId?: string;
  hasMore: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onDelete: (conversation: TripzConversation) => void;
  onRename: (conversation: TripzConversation, title: string) => Promise<void>;
  onLoadMore: () => void;
}) {
  const [editing, setEditing] = useState<TripzConversation>();
  const [draftTitle, setDraftTitle] = useState("");
  const sidebarRef = useRef<HTMLElement>(null);
  const onCloseMobileRef = useRef(onCloseMobile);
  onCloseMobileRef.current = onCloseMobile;

  useEffect(() => {
    if (!mobileOpen) return;
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const media = window.matchMedia("(max-width: 1023px)");
    let deactivate: (() => void) | undefined;
    const activate = () => {
      if (!media.matches || deactivate) return;
      const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const previousOverflow = document.body.style.overflow;
      const siblings = Array.from(sidebar.parentElement?.children ?? [])
        .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== sidebar)
        .map((element) => ({ element, inert: element.inert, ariaHidden: element.getAttribute("aria-hidden") }));
      siblings.forEach(({ element }) => {
        element.inert = true;
        element.setAttribute("aria-hidden", "true");
      });
      document.body.style.overflow = "hidden";
      sidebar.querySelector<HTMLElement>("[data-autofocus]")?.focus();
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCloseMobileRef.current();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = Array.from(sidebar.querySelectorAll<HTMLElement>(
          "a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex='-1'])"
        )).filter((element) => element.offsetParent !== null);
        if (focusable.length === 0) {
          event.preventDefault();
          sidebar.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable.at(-1)!;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === sidebar)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      };
      document.addEventListener("keydown", handleKeyDown);
      deactivate = () => {
        document.removeEventListener("keydown", handleKeyDown);
        document.body.style.overflow = previousOverflow;
        siblings.forEach(({ element, inert, ariaHidden }) => {
          element.inert = inert;
          if (ariaHidden === null) element.removeAttribute("aria-hidden");
          else element.setAttribute("aria-hidden", ariaHidden);
        });
        if (previousFocus?.isConnected) previousFocus.focus();
      };
    };
    const sync = () => {
      deactivate?.();
      deactivate = undefined;
      activate();
    };
    activate();
    media.addEventListener("change", sync);
    return () => {
      media.removeEventListener("change", sync);
      deactivate?.();
    };
  }, [mobileOpen]);

  const submitRename = async () => {
    const title = draftTitle.trim();
    if (!editing || !title || title === editing.title || renamingId) {
      if (title === editing?.title) setEditing(undefined);
      return;
    }
    try {
      await onRename(editing, title);
      setEditing(undefined);
    } catch {
      // O workspace exibe o erro e mantém o campo aberto para correção/tentativa.
    }
  };
  return (
    <aside
      ref={sidebarRef}
      className={`${mobileOpen ? "absolute inset-0 flex" : "hidden"} z-[2] min-h-0 w-full flex-col border-r border-[var(--border)] bg-[var(--side)] lg:static lg:flex lg:w-auto`}
      role={mobileOpen ? "dialog" : undefined}
      aria-modal={mobileOpen ? "true" : undefined}
      aria-labelledby="tripz-history-title"
      tabIndex={-1}
    >
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-4">
        <div>
          <span className="font-mono text-[9px] font-medium uppercase tracking-[.17em] text-[var(--accent)]">Tripz IA</span>
          <h2 id="tripz-history-title" className="m-0 mt-1 text-sm font-semibold tracking-tight text-[var(--text)]">Propostas</h2>
        </div>
        <button type="button" data-autofocus className="grid h-11 w-11 place-items-center border border-[var(--border)] bg-transparent text-[var(--muted)] transition-[background,transform] hover:bg-[var(--active)] hover:text-[var(--text)] active:translate-y-px lg:hidden" onClick={onCloseMobile} aria-label="Fechar histórico">
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="px-3 py-3">
        <button
          type="button"
          className="flex min-h-11 w-full items-center justify-between gap-3 border border-[var(--primary)] bg-[var(--primary)] px-3 py-2 text-left text-xs font-bold text-[var(--primary-fg)] transition-[transform,opacity] hover:opacity-90 active:translate-y-px disabled:opacity-50"
          disabled={creating}
          onClick={onCreate}
        >
          <span>{creating ? "Criando proposta…" : "Nova proposta"}</span>
          <Plus size={15} weight="bold" aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4" aria-busy={loading}>
        {loading ? (
          <div className="grid gap-2 px-1" role="status" aria-label="Carregando propostas">
            {[0, 1, 2, 3].map((item) => <span key={item} className="skeleton block h-[4.5rem] w-full" aria-hidden="true" />)}
          </div>
        ) : conversations.length === 0 ? (
          <div className="mx-2 mt-4 border-t border-[var(--border)] pt-5 text-left">
            <FileText size={22} className="text-[var(--faint-text)]" aria-hidden="true" />
            <p className="mb-0 mt-3 text-xs font-medium text-[var(--body)]">Nenhuma proposta ainda</p>
            <p className="mb-0 mt-1 text-[11px] leading-5 text-[var(--faint-text)]">Crie uma conversa para reunir voos, hospedagem e valores.</p>
          </div>
        ) : (
          <ul className="m-0 grid list-none gap-1 p-0">
            {conversations.map((conversation, index) => {
              const selected = conversation.id === selectedId;
              const isEditing = editing?.id === conversation.id;
              return (
                <li key={conversation.id} className="group relative" style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}>
                  {isEditing ? (
                    <form className="grid min-h-[4.5rem] grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1 border-l-2 border-[var(--accent)] bg-[var(--active)] px-2" onSubmit={(event) => { event.preventDefault(); void submitRename(); }}>
                      <label className="sr-only" htmlFor={`tripz-title-${conversation.id}`}>Nome da proposta</label>
                      <input id={`tripz-title-${conversation.id}`} className="min-w-0 border border-[var(--strong)] bg-[var(--input)] px-2 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]" value={draftTitle} maxLength={200} autoFocus disabled={renamingId === conversation.id} onChange={(event) => setDraftTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditing(undefined); }} />
                      <button type="submit" className="grid h-10 w-10 place-items-center bg-transparent text-[var(--accent)] disabled:opacity-40" disabled={!draftTitle.trim() || renamingId === conversation.id} aria-label="Salvar novo nome"><Check size={14} weight="bold" aria-hidden="true" /></button>
                      <button type="button" className="grid h-10 w-10 place-items-center bg-transparent text-[var(--muted)]" onClick={() => setEditing(undefined)} disabled={renamingId === conversation.id} aria-label="Cancelar renomeação"><X size={14} aria-hidden="true" /></button>
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={`grid min-h-[4.5rem] w-full grid-cols-[minmax(0,1fr)_auto] content-center gap-x-3 gap-y-1 border-l-2 px-3 py-2.5 pr-24 text-left transition-[background,border-color,transform] active:translate-y-px lg:pr-16 ${selected ? "border-[var(--accent)] bg-[var(--active)]" : "border-transparent bg-transparent hover:bg-[var(--panel)]"}`}
                        onClick={() => onSelect(conversation.id)}
                        aria-current={selected ? "true" : undefined}
                      >
                        <strong className="truncate text-xs font-semibold text-[var(--text)]">{conversation.title}</strong>
                        <time className="font-mono text-[9px] text-[var(--faint-text)]" dateTime={conversation.updatedAt}>{formatTripzTimestamp(conversation.updatedAt)}</time>
                        <span className="col-span-2 flex min-w-0 items-center gap-2 text-[10px] text-[var(--faint-text)]">
                          <StatusMark status={conversation.status} />
                          <span className="truncate">{tripzConversationStatusLabel(conversation.status)}</span>
                        </span>
                      </button>
                      <button type="button" className="absolute bottom-1.5 right-12 grid h-11 w-11 place-items-center border border-transparent bg-[var(--side)] text-[var(--faint-text)] opacity-100 transition-[opacity,background,transform] hover:bg-[var(--active)] hover:text-[var(--text)] focus-visible:opacity-100 active:scale-[.96] lg:bottom-2.5 lg:right-9 lg:h-7 lg:w-7 lg:opacity-0 lg:group-hover:opacity-100" onClick={() => { setEditing(conversation); setDraftTitle(conversation.title); }} aria-label={`Renomear ${conversation.title}`}><PencilSimple size={14} aria-hidden="true" /></button>
                      <button type="button" className="absolute bottom-1.5 right-1 grid h-11 w-11 place-items-center border border-transparent bg-[var(--side)] text-[var(--faint-text)] opacity-100 transition-[opacity,background,transform] hover:bg-[var(--warn-bg)] hover:text-[var(--warn)] focus-visible:opacity-100 active:scale-[.96] lg:bottom-2.5 lg:right-2 lg:h-7 lg:w-7 lg:opacity-0 lg:group-hover:opacity-100" onClick={() => onDelete(conversation)} aria-label={`Excluir ${conversation.title}`}><Trash size={14} aria-hidden="true" /></button>
                    </>
                  )}
                </li>
              );
            })}
            {hasMore ? (
              <li className="pt-2">
                <button type="button" className="btn w-full" disabled={loadingMore} onClick={onLoadMore}>
                  {loadingMore ? "Carregando…" : "Carregar mais"}
                </button>
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </aside>
  );
}
