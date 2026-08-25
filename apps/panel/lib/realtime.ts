"use client";

import { createContext, createElement, type ReactNode, useContext, useEffect, useRef } from "react";
import { parseAiTurnProgress, type AiTurnProgress } from "./ai-turn-progress";

export type RealtimeSignal =
  | { type: "conversation.messages.changed"; conversationId: string }
  | AiTurnProgress
  | { type: "alerts.changed" }
  | { type: "appointment.changed"; appointmentId: string; leadId: string }
  | {
      type: "case.assignment.changed";
      caseId: string;
      conversationId?: string;
      leadId?: string;
    };

type EventSourceLike = {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
};

type EventSourceFactory = (url: string, init: EventSourceInit) => EventSourceLike;

function realtimeUrl(tenantId: string): string {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/backend";
  return `${base}/events?tenantId=${encodeURIComponent(tenantId)}`;
}

export function parseRealtimeSignal(value: string): RealtimeSignal | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.type === "conversation.ai.progress") return parseAiTurnProgress(parsed);
    if (parsed.type === "alerts.changed") return { type: "alerts.changed" };
    if (
      parsed.type === "conversation.messages.changed"
      && typeof parsed.conversationId === "string"
    ) {
      return { type: parsed.type, conversationId: parsed.conversationId };
    }
    if (
      parsed.type === "appointment.changed"
      && typeof parsed.appointmentId === "string"
      && typeof parsed.leadId === "string"
    ) {
      return {
        type: parsed.type,
        appointmentId: parsed.appointmentId,
        leadId: parsed.leadId
      };
    }
    if (
      parsed.type === "case.assignment.changed"
      && typeof parsed.caseId === "string"
      && (parsed.conversationId === undefined || typeof parsed.conversationId === "string")
      && (parsed.leadId === undefined || typeof parsed.leadId === "string")
    ) {
      return {
        type: parsed.type,
        caseId: parsed.caseId,
        ...(typeof parsed.conversationId === "string"
          ? { conversationId: parsed.conversationId }
          : {}),
        ...(typeof parsed.leadId === "string" ? { leadId: parsed.leadId } : {})
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function createRealtimeSubscription(input: {
  tenantId: string;
  onCatchUp: () => void;
  onSignal: (signal: RealtimeSignal) => void;
  factory?: EventSourceFactory;
}): () => void {
  const factory = input.factory ?? ((url, init) => new EventSource(url, init));
  const source = factory(realtimeUrl(input.tenantId), { withCredentials: true });
  const seenEventIds = new Set<string>();
  source.addEventListener("catchup", () => {
    input.onCatchUp();
  });
  source.addEventListener("change", (event) => {
    if (event.lastEventId) {
      if (seenEventIds.has(event.lastEventId)) return;
      seenEventIds.add(event.lastEventId);
      if (seenEventIds.size > 1_000) {
        const oldest = seenEventIds.values().next().value;
        if (oldest) seenEventIds.delete(oldest);
      }
    }
    const signal = parseRealtimeSignal(event.data);
    if (signal) input.onSignal(signal);
  });
  return () => source.close();
}

type RealtimeListener = { onCatchUp: () => void; onSignal: (signal: RealtimeSignal) => void };
const RealtimeTenantContext = createContext<string | null>(null);

export function RealtimeTenantProvider({
  children,
  tenantId
}: {
  children: ReactNode;
  tenantId?: string | null;
}) {
  return createElement(RealtimeTenantContext.Provider, { value: tenantId ?? null }, children);
}

// ponytail: cada useRealtimeSignals() abria seu próprio EventSource; como o hook é chamado em
// paralelo por Shell, notificações e várias páginas, uma única tela chegava a 3-4 conexões SSE
// simultâneas para o mesmo endpoint. Multiplexa todos os assinantes numa única conexão compartilhada.
let shared: { tenantId: string; close: () => void; listeners: Set<RealtimeListener> } | null = null;

export function useRealtimeSignals(input: {
  onCatchUp: () => void;
  onSignal: (signal: RealtimeSignal) => void;
}): void {
  const tenantId = useContext(RealtimeTenantContext);
  const callbacks = useRef(input);
  callbacks.current = input;
  useEffect(() => {
    if (!tenantId) return;
    const listener: RealtimeListener = {
      onCatchUp: () => callbacks.current.onCatchUp(),
      onSignal: (signal) => callbacks.current.onSignal(signal)
    };
    const joiningExisting = shared?.tenantId === tenantId;
    if (shared && shared.tenantId !== tenantId) {
      shared.close();
      shared = null;
    }
    if (!shared) {
      const listeners = new Set<RealtimeListener>();
      const close = createRealtimeSubscription({
        tenantId,
        onCatchUp: () => listeners.forEach((l) => l.onCatchUp()),
        onSignal: (signal) => listeners.forEach((l) => l.onSignal(signal))
      });
      shared = { tenantId, close, listeners };
    }
    shared.listeners.add(listener);
    // ponytail: quem entra numa conexão já aberta perdeu o catchup original; simula um para ele.
    if (joiningExisting) listener.onCatchUp();
    return () => {
      if (!shared) return;
      shared.listeners.delete(listener);
      if (shared.listeners.size === 0) {
        shared.close();
        shared = null;
      }
    };
  }, [tenantId]);
}
