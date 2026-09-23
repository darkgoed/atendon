"use client";

import { Bell } from "@/components/icons";
import Link from "next/link";
import { useCallback } from "react";
import useSWR from "swr";
import { notificationBadgeLabel } from "@/lib/alerts";
import { api } from "@/lib/api";
import {
  INTERNAL_NOTIFICATIONS_PATH,
  formatRelativeNotificationTime,
  internalNotificationHref,
  type InternalNotification,
  type InternalNotificationsResponse
} from "@/lib/internal-notifications";
import { PopoverMenu } from "@/components/popover-menu";
import styles from "@/components/internal-notifications.module.css";

/**
 * Sino de notificações internas (R2 v6) — user-scoped, inline na topbar.
 * Sem realtime v1: SWR com poll de 30s. Falhas são silenciosas (a API pode
 * 404 até o backend integrar) — o sino vira um sino vazio, nunca um toast.
 */

const fetcher = (url: string) => api<InternalNotificationsResponse>(url, undefined, { reportErrors: false });

function markNotificationsRead(
  current: InternalNotificationsResponse,
  ids: readonly string[]
): InternalNotificationsResponse {
  const idSet = new Set(ids);
  let consumed = 0;
  const items = current.items.map((item) => {
    if (!idSet.has(item.id) || item.read_at) return item;
    consumed += 1;
    return { ...item, read_at: new Date().toISOString() };
  });
  return { ...current, items, total_unread: Math.max(0, current.total_unread - consumed) };
}

export function InternalNotifications() {
  const { data, mutate, isLoading } = useSWR<InternalNotificationsResponse>(INTERNAL_NOTIFICATIONS_PATH, fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: false,
    shouldRetryOnError: false,
    dedupingInterval: 10_000
  });
  const unread = data?.total_unread ?? 0;
  const items = data?.items ?? [];
  const badge = notificationBadgeLabel(unread);

  const markRead = useCallback(async (id: string) => {
    // Otimista: o contador decresce na hora; erro revalida e o poll corrige.
    await mutate((current) => current ? markNotificationsRead(current, [id]) : current, { revalidate: false });
    try {
      await api(`/me/internal-notifications/${encodeURIComponent(id)}/read`, { method: "POST" }, { reportErrors: false });
    } catch {
      void mutate();
    }
  }, [mutate]);

  const markAllRead = useCallback(async () => {
    await mutate((current) => current ? {
      ...current,
      items: current.items.map((item) => ({ ...item, read_at: item.read_at ?? new Date().toISOString() })),
      total_unread: 0
    } : current, { revalidate: false });
    try {
      await api("/me/internal-notifications/read-all", { method: "POST" }, { reportErrors: false });
    } catch {
      void mutate();
    }
  }, [mutate]);

  const openItem = (item: InternalNotification, close: () => void) => {
    close();
    if (!item.read_at) void markRead(item.id);
  };

  return (
    <PopoverMenu
      align="end"
      ariaLabel="Sino de notificações"
      title="Notificações"
      buttonClassName={styles.trigger}
      panelClassName={styles.panel}
      icon={(
        <span className={styles.bellWrap} aria-hidden="true">
          <Bell size={17} weight={unread > 0 ? "fill" : "regular"} />
          {badge ? <span className={styles.badge}>{badge}</span> : null}
        </span>
      )}
    >
      {(close) => (
        <div className={styles.inner} role="dialog" aria-modal="false" aria-label="Notificações internas">
          <header className={styles.header}>
            <strong>Notificações</strong>
            {items.some((item) => !item.read_at) ? (
              <button type="button" className={styles.markAll} onClick={() => void markAllRead()}>Marcar todas</button>
            ) : null}
          </header>
          <div className={styles.list} aria-live="polite">
            {items.length === 0 ? (
              <p className={styles.empty}>{isLoading ? "Carregando…" : "Sem notificações"}</p>
            ) : items.map((item) => {
              const href = internalNotificationHref(item);
              const content = (
                <>
                  <strong className={styles.itemTitle}>{item.title}</strong>
                  {item.body ? <span className={styles.itemBody}>{item.body}</span> : null}
                  <span className={styles.itemMeta}>
                    {[item.actor_name?.trim() || null, formatRelativeNotificationTime(item.created_at)].filter(Boolean).join(" · ")}
                  </span>
                </>
              );
              const className = `${styles.item}${item.read_at ? "" : ` ${styles.itemUnread}`}`;
              return href ? (
                <Link key={item.id} href={href} className={className} onClick={() => openItem(item, close)}>
                  {content}
                </Link>
              ) : (
                <button key={item.id} type="button" className={className} onClick={() => openItem(item, close)}>
                  {content}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </PopoverMenu>
  );
}