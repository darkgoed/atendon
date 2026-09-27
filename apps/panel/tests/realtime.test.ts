import { describe, expect, it, vi } from "vitest";
import {
  createRealtimeSubscription,
  parseRealtimeSignal
} from "../lib/realtime";

describe("realtime invalidation signals", () => {
  it("parses only the public signal shapes", () => {
    expect(parseRealtimeSignal('{"type":"alerts.changed"}')).toEqual({ type: "alerts.changed" });
    expect(parseRealtimeSignal(
      '{"type":"conversation.messages.changed","conversationId":"conversation-1"}'
    )).toEqual({
      type: "conversation.messages.changed",
      conversationId: "conversation-1"
    });
    expect(parseRealtimeSignal(
      '{"type":"case.assignment.changed","caseId":"lead-1","leadId":"lead-1"}'
    )).toEqual({
      type: "case.assignment.changed",
      caseId: "lead-1",
      leadId: "lead-1"
    });
    expect(parseRealtimeSignal(
      '{"type":"case.assignment.changed","caseId":"conversation-1","conversationId":"conversation-1"}'
    )).toEqual({
      type: "case.assignment.changed",
      caseId: "conversation-1",
      conversationId: "conversation-1"
    });
    expect(parseRealtimeSignal(
      '{"type":"appointment.changed","appointmentId":"appointment-1","leadId":"lead-1"}'
    )).toEqual({
      type: "appointment.changed",
      appointmentId: "appointment-1",
      leadId: "lead-1"
    });
    expect(parseRealtimeSignal(JSON.stringify({
      type: "conversation.ai.progress",
      conversationId: "conversation-1",
      turnId: "turn-1",
      attempt: 1,
      revision: 2,
      phase: "preview",
      preview: "Olá",
      startedAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-10T10:00:01.000Z",
      expiresAt: "2026-08-10T10:30:01.000Z"
    }))).toMatchObject({
      type: "conversation.ai.progress",
      phase: "preview",
      preview: "Olá"
    });
    expect(parseRealtimeSignal(JSON.stringify({
      type: "conversation.ai.progress",
      conversationId: "conversation-1",
      turnId: "turn-1",
      attempt: 1,
      revision: 2,
      phase: "using_tool",
      arguments: { secret: true },
      startedAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-10T10:00:01.000Z",
      expiresAt: "2026-08-10T10:30:01.000Z"
    }))).toBeNull();
    expect(parseRealtimeSignal('{"type":"appointment.changed","appointmentId":"appointment-1"}')).toBeNull();
    expect(parseRealtimeSignal('{"type":"case.assignment.changed"}')).toBeNull();
    expect(parseRealtimeSignal('{"type":"conversation.messages.changed"}')).toBeNull();
    expect(parseRealtimeSignal("not-json")).toBeNull();
  });

  it("uses credentials, catches up from PostgreSQL and deduplicates replayed event ids", () => {
    const listeners = new Map<string, (event: MessageEvent<string>) => void>();
    const close = vi.fn();
    const factory = vi.fn((url: string, init: EventSourceInit) => {
      expect(url).toMatch(/\/events\?tenantId=tenant%20a$/);
      expect(init).toEqual({ withCredentials: true });
      return {
        addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
          listeners.set(type, listener);
        },
        close
      };
    });
    const onCatchUp = vi.fn();
    const onSignal = vi.fn();
    const unsubscribe = createRealtimeSubscription({ tenantId: "tenant a", onCatchUp, onSignal, factory });

    listeners.get("catchup")?.({ data: "", lastEventId: "catchup" } as MessageEvent<string>);
    const event = {
      data: '{"type":"conversation.messages.changed","conversationId":"conversation-1"}',
      lastEventId: "opaque-1"
    } as MessageEvent<string>;
    listeners.get("change")?.(event);
    listeners.get("change")?.(event);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(onCatchUp).toHaveBeenCalledTimes(1);
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal).toHaveBeenCalledWith({
      type: "conversation.messages.changed",
      conversationId: "conversation-1"
    });
    unsubscribe();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("recria o EventSource com backoff quando a conexão é fechada de vez (ORG C9: 502/503 no deploy)", () => {
    vi.useFakeTimers();
    try {
      type Fake = { listeners: Map<string, (event: MessageEvent<string>) => void>; readyState: number; close: ReturnType<typeof vi.fn> };
      const sources: Fake[] = [];
      const factory = vi.fn(() => {
        const source: Fake = { listeners: new Map(), readyState: 0, close: vi.fn() };
        sources.push(source);
        return {
          get readyState() { return source.readyState; },
          addEventListener(type: string, listener: (event: MessageEvent<string>) => void) { source.listeners.set(type, listener); },
          close: source.close
        };
      });
      const onCatchUp = vi.fn();
      const unsubscribe = createRealtimeSubscription({ tenantId: "t", onCatchUp, onSignal: vi.fn(), factory });

      // Erro transitório (o navegador reconecta sozinho): não recria.
      sources[0].listeners.get("error")?.({} as MessageEvent<string>);
      vi.advanceTimersByTime(60_000);
      expect(factory).toHaveBeenCalledTimes(1);

      // Resposta não-200: o EventSource fecha de vez (readyState 2) e só volta se recriado.
      sources[0].readyState = 2;
      sources[0].listeners.get("error")?.({} as MessageEvent<string>);
      expect(sources[0].close).toHaveBeenCalled();
      vi.advanceTimersByTime(999);
      expect(factory).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(factory).toHaveBeenCalledTimes(2);

      // Nova falha dobra a espera; o catchup da reabertura zera o backoff e recupera os dados.
      sources[1].readyState = 2;
      sources[1].listeners.get("error")?.({} as MessageEvent<string>);
      vi.advanceTimersByTime(1_999);
      expect(factory).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1);
      expect(factory).toHaveBeenCalledTimes(3);
      sources[2].listeners.get("catchup")?.({ data: "", lastEventId: "c" } as MessageEvent<string>);
      expect(onCatchUp).toHaveBeenCalledTimes(1);

      // Cancelar a assinatura durante a espera não recria nada depois.
      sources[2].readyState = 2;
      sources[2].listeners.get("error")?.({} as MessageEvent<string>);
      unsubscribe();
      vi.advanceTimersByTime(60_000);
      expect(factory).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

