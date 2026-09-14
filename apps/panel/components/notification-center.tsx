"use client";

import { BellRinging, X } from "@phosphor-icons/react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import { ContactAvatar } from "@/components/contact-avatar";
import { api } from "@/lib/api";
import { notificationBadgeLabel } from "@/lib/alerts";
import { useRealtimeSignals } from "@/lib/realtime";

type UnreadConversation = {
  id: string;
  contact_phone: string;
  contact_name: string | null;
  avatar_url: string | null;
  last_message: string | null;
  last_message_at: string;
  unread_count: number;
};
type UnreadConversationsResponse = { conversations: UnreadConversation[] };

const fetcher = <T,>(url: string) => api<T>(url);
const notificationDateTime = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short"
});

function NotificationRealtimeSync({ onRefresh }: { onRefresh: () => void }) {
  useRealtimeSignals({
    onCatchUp: onRefresh,
    onSignal: (signal) => {
      if (signal.type === "conversation.messages.changed" || signal.type === "case.assignment.changed") onRefresh();
    }
  });
  return null;
}

export function NotificationCenter({ enabled, avoidBottomComposer = false }: { enabled: boolean; avoidBottomComposer?: boolean }) {
  const [open, setOpen] = useState(false);
  const conversationsPath = enabled ? "/conversations/unread" : null;
  const { data, error, mutate, isLoading } = useSWR<UnreadConversationsResponse>(conversationsPath, fetcher, {
    refreshInterval: 15_000,
    refreshWhenHidden: false,
    revalidateOnFocus: true,
    dedupingInterval: 3_000,
    shouldRetryOnError: false
  });
  const refreshVisible = useCallback(() => {
    if (document.visibilityState === "visible") void mutate();
  }, [mutate]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  if (!enabled) return null;

  const conversations = data?.conversations ?? [];
  const unread = conversations.reduce((total, item) => total + item.unread_count, 0);
  const badge = notificationBadgeLabel(unread);

  return (
    <>
      <NotificationRealtimeSync onRefresh={refreshVisible} />
      {open ? <button className="notification-center__backdrop" type="button" aria-label="Fechar notificações" onClick={() => setOpen(false)} /> : null}
      <aside className={`notification-center${avoidBottomComposer ? " notification-center--with-composer" : ""}`} aria-label="Central de notificações">
        {open ? (
          <div className="notification-center__panel" role="dialog" aria-modal="false" aria-labelledby="notification-center-title">
            <header className="notification-center__header">
              <div>
                <strong id="notification-center-title">Contatos</strong>
                <span>{unread === 1 ? "1 mensagem não lida" : `${unread} mensagens não lidas`}</span>
              </div>
              <div className="notification-center__header-actions">
                <button className="notification-center__close" type="button" aria-label="Fechar notificações" onClick={() => setOpen(false)}>
                  <X size={15} weight="bold" aria-hidden="true" />
                </button>
              </div>
            </header>

            <div className="notification-center__list" aria-live="polite">
              {error ? (
                <div className="notification-center__state" role="alert">
                  <p>Não foi possível carregar as notificações.</p>
                  <button type="button" onClick={() => void mutate()}>Tentar novamente</button>
                </div>
              ) : isLoading && !data ? (
                <div className="notification-center__skeleton" role="status" aria-label="Carregando notificações">
                  {[0, 1, 2].map((item) => (
                    <span key={item}><i className="skeleton" /><b><i className="skeleton" /><i className="skeleton" /></b></span>
                  ))}
                </div>
              ) : conversations.length === 0 ? (
                <div className="notification-center__state">Nenhuma mensagem não lida</div>
              ) : conversations.map((conversation) => (
                <Link
                  className="notification-center__item is-unread"
                  key={conversation.id}
                  href={`/conversas?id=${encodeURIComponent(conversation.id)}`}
                  onClick={() => setOpen(false)}
                  aria-label={`Abrir conversa com ${conversation.contact_name ?? conversation.contact_phone}, ${conversation.unread_count} não lidas`}
                >
                  <span className="notification-center__icon" aria-hidden="true">
                    <ContactAvatar name={conversation.contact_name ?? conversation.contact_phone} src={conversation.avatar_url} className="h-7 w-7 type-caption" />
                  </span>
                  <span className="notification-center__content">
                    <strong>{conversation.contact_name ?? conversation.contact_phone}</strong>
                    <span>{conversation.last_message ?? "Sem mensagens ainda"}</span>
                    <time dateTime={conversation.last_message_at}>
                      {notificationDateTime.format(new Date(conversation.last_message_at))}
                    </time>
                  </span>
                  <i className="notification-center__unread-dot" aria-hidden="true" />
                </Link>
              ))}
            </div>

            <footer className="notification-center__footer">
              <Link href="/conversas" onClick={() => setOpen(false)}>Ver todas as conversas</Link>
            </footer>
          </div>
        ) : null}

        <button
          className={`notification-center__trigger${unread > 0 ? " has-unread" : ""}`}
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={unread > 0 ? `Mensagens de contatos, ${unread} não lidas` : "Mensagens de contatos"}
          onClick={() => {
            setOpen((current) => !current);
            if (!open) void mutate();
          }}
        >
          <BellRinging size={21} weight={unread > 0 ? "fill" : "regular"} aria-hidden="true" />
          {badge ? <span className="notification-center__badge">{badge}</span> : null}
        </button>
      </aside>
    </>
  );
}
