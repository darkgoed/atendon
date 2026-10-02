"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import useSWR from "swr";
import { api } from "@/lib/api";
import { dismissToast, reportToast } from "@/lib/error-events";
import { conversationMessagesPath } from "@/lib/conversation-messages";
import { confirmLeave } from "@/lib/leave-guard";
import {
  panelFeatureEnabled,
  type PanelFeatureFlagsResponse
} from "@/lib/feature-flags";
import {
  claimPanelNotification,
  clearPanelTabState,
  conversationVisibleInAnyPanelTab,
  messageNotificationFromThread,
  publishPanelTabState,
  type PanelNotificationPreferencesResponse,
  type NotificationThreadResponse
} from "@/lib/message-notifications";
import { playNotificationSound } from "@/lib/notification-sounds";
import { useRealtimeSignals, type RealtimeSignal } from "@/lib/realtime";

const fetcher = <T,>(url: string) => api<T>(url);

function MessageRealtimeSync({
  onSignal
}: {
  onSignal: (signal: RealtimeSignal) => void;
}) {
  useRealtimeSignals({
    onCatchUp: () => undefined,
    onSignal
  });
  return null;
}

export function MessageNotifications({
  activeConversationId,
  enabled,
  tenantId,
  onOpenConversation
}: {
  activeConversationId?: string;
  enabled: boolean;
  tenantId?: string;
  onOpenConversation?: (conversationId: string) => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const seenMessageIdsRef = useRef(new Set<string>());
  const activeConversationIdRef = useRef(activeConversationId);
  const tabIdRef = useRef(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
  activeConversationIdRef.current = activeConversationId;

  const { data: featureFlags } = useSWR<PanelFeatureFlagsResponse>(
    enabled ? "/feature-flags" : null,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 5_000 }
  );
  const deltaEnabled = panelFeatureEnabled(featureFlags, "conversations_delta_v2");
  const { data: preferencesData } = useSWR<PanelNotificationPreferencesResponse>(
    enabled ? "/me/notification-preferences" : null,
    fetcher,
    { revalidateOnFocus: true, dedupingInterval: 5_000 }
  );

  useEffect(() => {
    if (!enabled || !tenantId) return;
    const tabId = tabIdRef.current;
    const publish = () => {
      try {
        publishPanelTabState(localStorage, tenantId, tabId, {
          visible: document.visibilityState === "visible",
          ...(activeConversationIdRef.current ? { activeConversationId: activeConversationIdRef.current } : {})
        });
      } catch { /* sem storage compartilhado */ }
    };
    publish();
    const interval = window.setInterval(publish, 10_000);
    document.addEventListener("visibilitychange", publish);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", publish);
      try { clearPanelTabState(localStorage, tenantId, tabId); } catch { /* sem storage */ }
    };
  }, [activeConversationId, enabled, tenantId]);

  const handleSignal = useCallback((signal: RealtimeSignal) => {
    if (signal.type !== "conversation.messages.changed") return;
    void api<NotificationThreadResponse>(
      conversationMessagesPath(signal.conversationId, deltaEnabled)
    ).then((thread) => {
      const nextNotification = messageNotificationFromThread(thread);
      if (!nextNotification || seenMessageIdsRef.current.has(nextNotification.id)) return;

      const notificationConfig = preferencesData;
      if (!notificationConfig?.preferences.enabled) return;
      const preferences = notificationConfig.preferences;
      if (notificationConfig.muted_conversations.some((conversation) => conversation.id === nextNotification.conversationId)) return;
      try {
        if (!tenantId) return;
        if (conversationVisibleInAnyPanelTab(localStorage, tenantId, nextNotification.conversationId)) return;
        if (!claimPanelNotification(localStorage, tenantId, nextNotification.id)) return;
      } catch {
        // A deduplicação em memória ainda funciona quando storage está bloqueado.
      }

      seenMessageIdsRef.current.add(nextNotification.id);
      if (seenMessageIdsRef.current.size > 1_000) {
        const oldest = seenMessageIdsRef.current.values().next().value;
        if (oldest) seenMessageIdsRef.current.delete(oldest);
      }

      if (preferences.sound_enabled) playNotificationSound(preferences.sound_key, preferences.volume);
      if (preferences.visual_enabled) {
        const token = reportToast(
          <button
            className="chip-action"
            type="button"
            onClick={() => {
              if (pathname.startsWith("/conversas") && onOpenConversation) onOpenConversation(nextNotification.conversationId);
              else {
                if (!confirmLeave()) return;
                router.push(`/conversas?id=${encodeURIComponent(nextNotification.conversationId)}`);
              }
              dismissToast(token);
            }}
            aria-label={`Abrir conversa com ${nextNotification.contactName}: ${nextNotification.preview}`}
          >
            <strong>{nextNotification.contactName}</strong>{" · "}{nextNotification.preview}
          </button>,
          { kind: "info", duration: 4_300 }
        );
        if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
          const desktop = new Notification(nextNotification.contactName, {
            body: nextNotification.preview,
            tag: `atendon-message-${tenantId}-${nextNotification.id}`,
            silent: true
          });
          desktop.onclick = () => {
            window.focus();
            if (confirmLeave()) router.push(`/conversas?id=${encodeURIComponent(nextNotification.conversationId)}`);
            desktop.close();
          };
        }
      }
    }).catch(() => undefined);
  }, [deltaEnabled, onOpenConversation, pathname, preferencesData, router, tenantId]);

  return enabled ? <MessageRealtimeSync onSignal={handleSignal} /> : null;
}
