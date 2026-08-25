import { describe, expect, it } from "vitest";
import {
  clearedConversationDeltaPagination,
  conversationFallbackPollingDelay,
  conversationMessageDateSeparator,
  conversationMessagesLegacyPath,
  conversationMessagesPath,
  conversationMessagesV2Path,
  mergeConversationMessages,
  scrollTopAfterPrepend
} from "../lib/conversation-messages";

type TestMessage = { id: string; created_at: string; content: string };

describe("conversation message deltas", () => {
  it("merges and deduplicates deltas in stable timestamp/id order", () => {
    const timestamp = "2030-01-01T12:00:00.000Z";
    const current: TestMessage[] = [
      { id: "00000000-0000-4000-8000-000000000002", created_at: timestamp, content: "dois" },
      { id: "00000000-0000-4000-8000-000000000004", created_at: "2030-01-01T12:00:01.000Z", content: "quatro antigo" }
    ];
    const delta: TestMessage[] = [
      { id: "00000000-0000-4000-8000-000000000003", created_at: timestamp, content: "três" },
      { id: "00000000-0000-4000-8000-000000000001", created_at: timestamp, content: "um" },
      { id: "00000000-0000-4000-8000-000000000004", created_at: "2030-01-01T12:00:01.000Z", content: "quatro atualizado" }
    ];

    const merged = mergeConversationMessages(current, delta);
    expect(merged.map((message) => message.id)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000004"
    ]);
    expect(merged.at(-1)?.content).toBe("quatro atualizado");
  });

  it("builds initial, before and after URLs without exposing cursor contents", () => {
    expect(conversationMessagesV2Path("conversation", { limit: 100 }))
      .toBe("/conversations/conversation/messages/v2?limit=100");
    expect(conversationMessagesV2Path("conversation", { before: "opaque+/=" }))
      .toBe("/conversations/conversation/messages/v2?before=opaque%2B%2F%3D");
    expect(conversationMessagesV2Path("conversation", { after: "cursor_after" }))
      .toBe("/conversations/conversation/messages/v2?after=cursor_after");
  });

  it("switches between legacy and delta paths while preserving a deduplicated thread", () => {
    expect(conversationMessagesPath("conversation", false))
      .toBe(conversationMessagesLegacyPath("conversation"));
    expect(conversationMessagesPath("conversation", true))
      .toBe(conversationMessagesV2Path("conversation", { limit: 100 }));

    const legacy: TestMessage[] = [
      { id: "old", created_at: "2030-01-01T10:00:00.000Z", content: "antiga" },
      { id: "shared", created_at: "2030-01-01T11:00:00.000Z", content: "compartilhada" }
    ];
    const delta: TestMessage[] = [
      { id: "shared", created_at: "2030-01-01T11:00:00.000Z", content: "atualizada" },
      { id: "new", created_at: "2030-01-01T12:00:00.000Z", content: "nova" }
    ];

    const afterEnable = mergeConversationMessages(legacy, delta);
    const afterKill = mergeConversationMessages(afterEnable, legacy);
    expect(afterEnable.map(({ id }) => id)).toEqual(["old", "shared", "new"]);
    expect(afterKill.map(({ id }) => id)).toEqual(["old", "shared", "new"]);
    expect(new Set(afterKill.map(({ id }) => id)).size).toBe(afterKill.length);
    expect(clearedConversationDeltaPagination()).toEqual({
      beforeCursor: null,
      afterCursor: null,
      hasMoreBefore: false
    });
  });

  it("pauses fallback polling while hidden and backs off without exceeding the catch-up bound", () => {
    expect(conversationFallbackPollingDelay({
      deltaEnabled: true,
      failures: 0,
      visibilityState: "hidden"
    })).toBeNull();
    expect(conversationFallbackPollingDelay({
      deltaEnabled: true,
      failures: 1,
      visibilityState: "visible"
    })).toBe(10_000);
    expect(conversationFallbackPollingDelay({
      deltaEnabled: true,
      failures: 20,
      visibilityState: "visible"
    })).toBe(15_000);
    expect(conversationFallbackPollingDelay({
      deltaEnabled: false,
      failures: 0,
      visibilityState: "visible"
    })).toBe(15_000);
  });

  it("labels date changes in the workspace timezone as Hoje, Ontem or DD/MM/AAAA", () => {
    const now = new Date("2030-01-03T02:30:00.000Z");
    const messages: TestMessage[] = [
      { id: "old", created_at: "2029-12-31T15:00:00.000Z", content: "antiga" },
      { id: "yesterday-1", created_at: "2030-01-01T13:00:00.000Z", content: "ontem 1" },
      { id: "yesterday-2", created_at: "2030-01-02T02:30:00.000Z", content: "ontem 2" },
      { id: "today", created_at: "2030-01-02T03:30:00.000Z", content: "hoje" }
    ];

    expect(messages.map((message, index) => conversationMessageDateSeparator(
      message,
      messages[index - 1],
      "America/Sao_Paulo",
      now
    ))).toEqual(["31/12/2029", "Ontem", null, "Hoje"]);
  });

  it("keeps exactly one separator per local day after old pages, realtime deltas and refreshes", () => {
    const now = new Date("2030-01-03T15:00:00.000Z");
    const initial: TestMessage[] = [
      { id: "day-2-a", created_at: "2030-01-02T12:00:00.000Z", content: "inicial" },
      { id: "day-2-b", created_at: "2030-01-02T13:00:00.000Z", content: "inicial 2" }
    ];
    const withOlder = mergeConversationMessages(initial, [
      { id: "day-1-a", created_at: "2030-01-01T12:00:00.000Z", content: "antiga" },
      { id: "day-1-b", created_at: "2030-01-01T13:00:00.000Z", content: "antiga 2" }
    ]);
    const withRealtime = mergeConversationMessages(withOlder, [
      { id: "day-3-a", created_at: "2030-01-03T12:00:00.000Z", content: "tempo real" }
    ]);
    const afterRefresh = mergeConversationMessages(withRealtime, [
      { id: "day-2-b", created_at: "2030-01-02T13:00:00.000Z", content: "atualizada" },
      { id: "day-3-a", created_at: "2030-01-03T12:00:00.000Z", content: "tempo real" }
    ]);

    expect(afterRefresh.map((message) => message.id)).toEqual([
      "day-1-a",
      "day-1-b",
      "day-2-a",
      "day-2-b",
      "day-3-a"
    ]);
    expect(afterRefresh.map((message, index) => conversationMessageDateSeparator(
      message,
      afterRefresh[index - 1],
      "UTC",
      now
    )).filter(Boolean)).toEqual(["01/01/2030", "Ontem", "Hoje"]);
  });

  it("preserves the visible scroll anchor when prepending rows and separators", () => {
    expect(scrollTopAfterPrepend(240, 1_200, 1_680)).toBe(720);
    expect(scrollTopAfterPrepend(240, 1_200, 1_100)).toBe(240);
  });
});
