"use client";

import {
  ArrowClockwise,
  ArrowDown,
  ArrowSquareOut,
  FileText,
  ImageSquare,
  LinkSimple,
  PencilSimple,
  Trash,
  X
} from "@/components/icons";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { ContactAvatar } from "./contact-avatar";
import { ConversationNotes } from "./conversation-notes";
import { Button, Dialog, IconButton, Input, SaveButton, SaveToast, useSaveFeedback } from "@/components/ui";
import { instagramDisplayIdentity, instagramDisplayName } from "@/lib/channel-identity";
import { shouldSubmitOnEnter } from "@/lib/compat";

export type ContactPanelMessage = {
  id: string;
  content: string;
  media_type: "audio" | "image" | "video" | "document" | null;
  media_mime_type?: string | null;
  media_file_name?: string | null;
  media_size_bytes?: number | null;
};

export type ContactPanelConversation = {
  id: string;
  contact_name?: string;
  contact_phone: string | null;
  contact_identifier?: string | null;
  instagram_username?: string | null;
  channel?: "whatsapp" | "instagram" | null;
  avatar_url?: string | null;
};

type PanelTab = "media" | "links" | "docs";

function mediaUrl(conversationId: string, messageId: string): string {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/backend";
  return `${base}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/media`;
}

function formatBytes(bytes?: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const linkPattern = /https?:\/\/[^\s<>"']+/gi;

export function ConversationContactPanel({
  conversation,
  messages,
  assetsLoading = false,
  assetsLoadingMore = false,
  assetsHasMore = false,
  assetsError = "",
  canEdit = true,
  returnFocus,
  onClose,
  onLoadMoreAssets,
  onRetryAssets,
  onClearConversation,
  onSaveContactName
}: {
  conversation: ContactPanelConversation;
  messages: ContactPanelMessage[];
  assetsLoading?: boolean;
  assetsLoadingMore?: boolean;
  assetsHasMore?: boolean;
  assetsError?: string;
  canEdit?: boolean;
  returnFocus?: HTMLElement | null;
  onClose: () => void;
  onLoadMoreAssets?: () => void;
  onRetryAssets?: () => void;
  onClearConversation: () => void;
  onSaveContactName: (name: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<PanelTab>("media");
  const [editing, setEditing] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [draftName, setDraftName] = useState(conversation.contact_name ?? "");
  const nameSave = useSaveFeedback();
  const [viewerId, setViewerId] = useState<string | null>(null);
  const viewerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const compositionActiveRef = useRef(false);
  const compositionJustEndedRef = useRef(false);
  const title = conversation.channel === "instagram"
    ? instagramDisplayName(conversation.contact_name, conversation.instagram_username, conversation.contact_identifier, conversation.contact_phone)
    : conversation.contact_name?.trim() || conversation.contact_phone || "Contato sem identificação";

  useEffect(() => {
    const panel = panelRef.current;
    const previousFocus = returnFocus
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const focusPanel = () => panel?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    focusPanel();
    const focusFrame = window.requestAnimationFrame(focusPanel);
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      // Radix layers (e.g. the image dialog) dismiss on Escape in the capture
      // phase and preventDefault: that Escape closes the layer, not the panel.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      // On compact layouts the trigger lives in a thread hidden while this
      // panel is mounted. Restore focus only after React has made the thread
      // visible again; focusing it during the cleanup is ignored by browsers.
      window.requestAnimationFrame(() => {
        if (previousFocus?.isConnected) previousFocus.focus();
      });
    };
  }, [returnFocus]);

  function selectTabWithKeyboard(event: KeyboardEvent<HTMLButtonElement>, key: PanelTab) {
    const tabs: PanelTab[] = ["media", "links", "docs"];
    const current = tabs.indexOf(key);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? tabs.length - 1
        : event.key === "ArrowRight" ? (current + 1) % tabs.length
          : event.key === "ArrowLeft" ? (current - 1 + tabs.length) % tabs.length
            : -1;
    if (next < 0) return;
    event.preventDefault();
    setTab(tabs[next]);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role='tab']")[next]?.focus();
  }

  const media = useMemo(
    () => messages.filter((message) => message.media_type === "image"),
    [messages]
  );
  const docs = useMemo(
    () => messages.filter((message) => message.media_type === "document"),
    [messages]
  );
  const viewerImage = media.find((message) => message.id === viewerId);
  const links = useMemo(() => {
    const seen = new Set<string>();
    return messages.flatMap((message) => {
      const found = message.content.match(linkPattern) ?? [];
      return found.filter((link) => {
        const normalized = link.replace(/[),.!?]+$/, "");
        if (seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
      }).map((link) => link.replace(/[),.!?]+$/, ""));
    });
  }, [messages]);

  async function saveName() {
    const name = draftName.trim();
    if (!name || savingName) return;
    setSaveError("");
    setSavingName(true);
    try {
      await onSaveContactName(name);
      nameSave.markDone();
      setEditing(false);
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "Falha ao editar o contato");
    } finally {
      setSavingName(false);
    }
  }

  return (
    <aside ref={panelRef} className="conversation-contact-panel min-h-0 min-w-0" aria-label="Dados do contato" tabIndex={-1}>
      <header className="conversation-contact-panel__header flex shrink-0 items-center justify-between px-4 py-3">
        <h2 className="text-sm font-semibold text-[var(--text)]">Dados do lead</h2>
        <IconButton type="button" label="Fechar dados do contato" title="Fechar" autoFocus data-autofocus onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </IconButton>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="conversation-contact-panel__identity border-b border-[var(--border-subtle)] px-4">
          <div className="flex min-w-0 items-center gap-3">
            <ContactAvatar name={title} src={conversation.avatar_url} className="h-10 w-10 shrink-0 text-sm" />
            <div className="flex min-w-0 flex-1 items-center gap-2">
            {editing ? (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <label className="sr-only" htmlFor="contact-name-edit">Nome do contato</label>
                <Input
                  id="contact-name-edit"
                  className="input text-center"
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  onCompositionStart={() => { compositionActiveRef.current = true; }}
                  onCompositionEnd={() => {
                    compositionActiveRef.current = false;
                    // Safari: o keydown do Enter que confirma a composição vem
                    // depois deste evento, com isComposing=false — não salva.
                    compositionJustEndedRef.current = true;
                  }}
                  onKeyDown={(event) => {
                    const compositionJustEnded = compositionJustEndedRef.current;
                    compositionJustEndedRef.current = false;
                    if (!shouldSubmitOnEnter({
                      key: event.key,
                      shiftKey: event.shiftKey,
                      isComposing: event.nativeEvent.isComposing,
                      keyCode: event.nativeEvent.keyCode,
                      compositionActive: compositionActiveRef.current,
                      compositionJustEnded
                    })) return;
                    void saveName();
                  }}
                  disabled={savingName}
                  autoFocus
                />
                <SaveButton type="button" state={savingName ? "busy" : nameSave.state} onClick={() => void saveName()} disabled={savingName}>Salvar</SaveButton>
              </div>
            ) : (
              <>
                <strong className="truncate text-sm font-semibold text-[var(--text)]">{title}</strong>
                {canEdit ? (
                  <IconButton
                    type="button"
                    label="Editar nome do contato"
                    title="Editar contato"
                    onClick={() => { setDraftName(conversation.contact_name ?? ""); setEditing(true); }}
                  >
                    <PencilSimple size={16} aria-hidden="true" />
                  </IconButton>
                ) : null}
              </>
            )}
            </div>
          </div>
          {saveError ? <p className="mt-2 text-left text-xs text-[var(--warning-text)]" role="alert">{saveError}</p> : null}
          <p className="mono mt-2 truncate text-xs text-[var(--text-muted)]" dir="ltr">{conversation.channel === "instagram" ? instagramDisplayIdentity(conversation.instagram_username, conversation.contact_identifier) : conversation.contact_phone ?? "Identidade sem telefone"}</p>
        </section>

        <section className="border-b border-[var(--border-subtle)] px-4 py-3.5" aria-labelledby="contact-panel-content-title">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 id="contact-panel-content-title" className="conversation-contact-panel__section-title">Mídia, links e docs</h3>
            <span className="mono text-xs text-[var(--text-muted)]">{media.length + links.length + docs.length}</span>
          </div>
          <div className="grid grid-cols-3 gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] p-1" role="tablist" aria-label="Conteúdo da conversa">
            {([[
              "media", "Mídia", ImageSquare
            ], ["links", "Links", LinkSimple], ["docs", "Docs", FileText]] as const).map(([key, label, Icon]) => (
              <Button
                type="button"
                key={key}
                className={`conversation-contact-panel__tab ${tab === key ? "is-active" : ""}`}
                onClick={() => setTab(key)}
                onKeyDown={(event) => selectTabWithKeyboard(event, key)}
                role="tab"
                aria-selected={tab === key}
                aria-controls={`contact-panel-${key}`}
                id={`contact-panel-${key}-tab`}
                tabIndex={tab === key ? 0 : -1}
              >
                <Icon size={14} aria-hidden="true" />
                <span>{label}</span>
              </Button>
            ))}
          </div>

          {assetsLoading ? (
            <div className="mt-3 grid grid-cols-3 gap-1.5" aria-label="Carregando conteúdo compartilhado" aria-busy="true">
              {Array.from({ length: 6 }).map((_, index) => <span key={index} className="skeleton aspect-square rounded-md" />)}
            </div>
          ) : null}

          {assetsError ? (
            <div className="mt-3 flex items-center justify-between gap-2 border rounded-[var(--radius-md)] border-[var(--warning-border)] bg-[var(--warning-subtle)] p-2 text-xs text-[var(--warning-text)]" role="alert">
              <span>{assetsError}</span>
              {onRetryAssets ? <IconButton type="button" label="Tentar novamente" onClick={onRetryAssets}><ArrowClockwise size={14} aria-hidden="true" /></IconButton> : null}
            </div>
          ) : null}

          {!assetsLoading && tab === "media" ? (
            media.length ? (
              <div id="contact-panel-media" className="mt-3 grid grid-cols-3 gap-1.5" role="tabpanel" aria-labelledby="contact-panel-media-tab">
                {media.map((message) => (
                  <button
                    key={message.id}
                    type="button"
                    className="conversation-contact-panel__media-thumb"
                    aria-label={`Abrir ${message.media_file_name ?? "imagem"}`}
                    onClick={(event) => { viewerTriggerRef.current = event.currentTarget; setViewerId(message.id); }}
                  >
                    {/* Authenticated media is loaded directly so the browser forwards the session cookie. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={mediaUrl(conversation.id, message.id)} alt={message.media_file_name ?? "Imagem da conversa"} loading="lazy" />
                  </button>
                ))}
              </div>
            ) : <p id="contact-panel-media" className="conversation-contact-panel__empty" role="tabpanel" aria-labelledby="contact-panel-media-tab">Nenhuma imagem compartilhada.</p>
          ) : null}

          {!assetsLoading && tab === "links" ? (
            links.length ? (
              <div id="contact-panel-links" className="mt-3 grid gap-1.5" role="tabpanel" aria-labelledby="contact-panel-links-tab">
                {links.map((link) => (
                  <a key={link} href={link} target="_blank" rel="noreferrer" className="conversation-contact-panel__resource">
                    <LinkSimple size={16} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{link}</span>
                    <ArrowSquareOut size={14} aria-hidden="true" />
                  </a>
                ))}
              </div>
            ) : <p id="contact-panel-links" className="conversation-contact-panel__empty" role="tabpanel" aria-labelledby="contact-panel-links-tab">Nenhum link compartilhado.</p>
          ) : null}

          {!assetsLoading && tab === "docs" ? (
            docs.length ? (
              <div id="contact-panel-docs" className="mt-3 grid gap-1.5" role="tabpanel" aria-labelledby="contact-panel-docs-tab">
                {docs.map((message) => (
                  <a key={message.id} href={mediaUrl(conversation.id, message.id)} target="_blank" rel="noreferrer" className="conversation-contact-panel__resource">
                    <FileText size={18} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-xs text-[var(--text)]">{message.media_file_name ?? "Documento"}</strong>
                      <span className="mono mt-0.5 block truncate text-xs text-[var(--text-muted)]">{message.media_mime_type ?? "arquivo"}{message.media_size_bytes ? ` · ${formatBytes(message.media_size_bytes)}` : ""}</span>
                    </span>
                    <ArrowDown size={15} aria-hidden="true" />
                  </a>
                ))}
              </div>
            ) : <p id="contact-panel-docs" className="conversation-contact-panel__empty" role="tabpanel" aria-labelledby="contact-panel-docs-tab">Nenhum documento compartilhado.</p>
          ) : null}
          {!assetsLoading && assetsHasMore && onLoadMoreAssets ? (
            <Button type="button" className="btn mt-3 w-full" onClick={onLoadMoreAssets} disabled={assetsLoadingMore}>
              {assetsLoadingMore ? "Carregando mais…" : "Carregar mais conteúdo"}
            </Button>
          ) : null}
        </section>

        <section className="border-b border-[var(--border-subtle)] px-4 py-3.5" aria-label="Nota interna da conversa">
          <ConversationNotes conversationId={conversation.id} />
        </section>
        {canEdit ? (
          <section className="px-4 py-4">
            <IconButton type="button" tone="danger" label="Limpar conversa" onClick={onClearConversation}>
              <Trash size={17} aria-hidden="true" />
            </IconButton>
          </section>
        ) : null}
      </div>
      <Dialog
        open={Boolean(viewerImage)}
        onOpenChange={(open) => {
          if (open) return;
          setViewerId(null);
          // No Radix Dialog.Trigger here, so focus goes back to the thumbnail that opened it.
          window.requestAnimationFrame(() => viewerTriggerRef.current?.focus());
        }}
        title={viewerImage?.media_file_name ?? "Imagem da conversa"}
        size="xl"
      >
        {viewerImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={mediaUrl(conversation.id, viewerImage.id)} alt={viewerImage.media_file_name ?? "Imagem da conversa"} className="mx-auto block max-h-[70vh] max-w-full object-contain" />
        ) : null}
      </Dialog>
      <SaveToast show={nameSave.done}>Contato salvo</SaveToast>
    </aside>
  );
}
