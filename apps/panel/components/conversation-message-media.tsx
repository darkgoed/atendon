"use client";

import { useRef, useState } from "react";
import { FileArrowDown } from "@/components/icons";
import { Dialog } from "@/components/ui/dialog";
import { VoiceMessagePlayer } from "@/components/ui/voice-input";

export interface ConversationMediaMessage {
  id: string;
  content: string;
  media_type: "audio" | "image" | "video" | "document";
  media_mime_type?: string | null;
  media_file_name?: string | null;
  media_size_bytes?: number | null;
  media_is_sticker?: boolean;
}

function apiMediaUrl(conversationId: string, messageId: string): string {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/backend";
  return `${base}/conversations/${conversationId}/messages/${messageId}/media`;
}

function formatBytes(bytes?: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ConversationMessageMedia({ conversationId, message }: { conversationId: string; message: ConversationMediaMessage }) {
  const src = apiMediaUrl(conversationId, message.id);
  const [viewerOpen, setViewerOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Opens the same authenticated src in a modal (no new tab). Without a Radix
  // Dialog.Trigger nothing restores focus, so it goes back to our trigger on close.
  function mediaViewer(alt: string, title: string, label: string, thumbClassName: string) {
    return (
      <>
        <button ref={triggerRef} type="button" onClick={() => setViewerOpen(true)} aria-label={label} className="block max-w-full cursor-zoom-in">
          {/* Authenticated media must load directly so the browser forwards the session cookie. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={alt} loading="lazy" className={thumbClassName} />
        </button>
        <Dialog
          open={viewerOpen}
          onOpenChange={(open) => {
            setViewerOpen(open);
            if (!open) requestAnimationFrame(() => triggerRef.current?.focus());
          }}
          title={title}
          size="xl"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={alt} className="mx-auto block max-h-[70vh] max-w-full object-contain" />
        </Dialog>
      </>
    );
  }

  if (message.media_is_sticker) {
    return mediaViewer("Figurinha", "Figurinha", "Abrir figurinha em tamanho original", "max-h-48 max-w-48 object-contain sm:max-h-56 sm:max-w-56");
  }

  if (message.media_type === "audio") {
    return (
      <div className="media-preview-min-width">
        <VoiceMessagePlayer src={src} />
      </div>
    );
  }

  if (message.media_type === "video") {
    return <video src={src} controls preload="metadata" className="max-h-80 max-w-full rounded-md" aria-label={message.content || message.media_file_name || "Vídeo"} />;
  }

  const rawFileName = message.media_file_name || (message.media_type === "image" ? "Imagem" : "Documento");
  const fileName = rawFileName;

  if (message.media_type === "image") {
    return (
      <div className="overflow-hidden">
        {mediaViewer(message.content || fileName, fileName, "Abrir imagem em tamanho original", "media-preview-frame w-auto max-w-full rounded-md object-contain")}
        {message.content && message.content !== fileName ? <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[var(--text)]">{message.content}</p> : null}
      </div>
    );
  }

  return (
    <a href={src} className="media-preview-download-min-width flex items-center gap-3 rounded-md border border-[var(--border)] px-3 py-2.5 transition hover:border-[var(--border-strong)]" download>
      <FileArrowDown size={24} className="shrink-0 text-[var(--primary-text)]" />
      <span className="min-w-0 flex-1">
        <strong className="block truncate text-xs text-[var(--text)]">{fileName}</strong>
        <span className="mt-1 block text-xs text-[var(--text-muted)]">{message.media_mime_type || "arquivo"}{message.media_size_bytes ? ` · ${formatBytes(message.media_size_bytes)}` : ""}</span>
      </span>
    </a>
  );
}
