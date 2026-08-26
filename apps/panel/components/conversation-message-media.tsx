"use client";

import { FileArrowDown } from "@phosphor-icons/react";
import { VoiceMessagePlayer } from "@/components/ui/voice-input";

export interface ConversationMediaMessage {
  id: string;
  content: string;
  media_type: "audio" | "image" | "document";
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

  if (message.media_is_sticker) {
    return (
      <a href={src} target="_blank" rel="noreferrer" aria-label="Abrir figurinha em tamanho original" className="block">
        {/* Authenticated media must load directly so the browser forwards the session cookie. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="Figurinha" loading="lazy" className="max-h-48 max-w-48 object-contain sm:max-h-56 sm:max-w-56" />
      </a>
    );
  }

  if (message.media_type === "audio") {
    return (
      <div className="min-w-[min(19rem,72vw)]">
        <VoiceMessagePlayer src={src} />
      </div>
    );
  }

  const rawFileName = message.media_file_name || (message.media_type === "image" ? "Imagem" : "Documento");
  const fileName = rawFileName;

  if (message.media_type === "image") {
    return (
      <div className="overflow-hidden">
        <a href={src} target="_blank" rel="noreferrer" aria-label="Abrir imagem em tamanho original">
          {/* Authenticated media must load directly so the browser forwards the session cookie. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={message.content || fileName} loading="lazy" className="max-h-[28rem] w-auto max-w-full rounded-[8px] object-contain" />
        </a>
        {message.content && message.content !== fileName ? <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[var(--text)]">{message.content}</p> : null}
      </div>
    );
  }

  return (
    <a href={src} className="flex min-w-[min(18rem,72vw)] items-center gap-3 rounded-[9px] border border-[var(--border)] px-3 py-2.5 transition hover:border-[var(--strong)]" download>
      <FileArrowDown size={24} className="shrink-0 text-[var(--accent-soft)]" />
      <span className="min-w-0 flex-1">
        <strong className="block truncate text-xs text-[var(--text)]">{fileName}</strong>
        <span className="mono mt-1 block text-[10px] uppercase tracking-[0.08em] text-[var(--faint)]">{message.media_mime_type || "arquivo"}{message.media_size_bytes ? ` · ${formatBytes(message.media_size_bytes)}` : ""}</span>
      </span>
    </a>
  );
}
