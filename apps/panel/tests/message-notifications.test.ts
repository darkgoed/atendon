import { describe, expect, it } from "vitest";
import {
  claimPanelNotification,
  conversationVisibleInAnyPanelTab,
  messageNotificationFromThread,
  publishPanelTabState
} from "../lib/message-notifications";

const now = new Date("2026-08-03T12:00:00.000Z").getTime();

describe("message notifications", () => {
  function storage() {
    const values = new Map<string, string>();
    return {
      get length() { return values.size; },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); }
    };
  }

  it("deduplicates delivery and suppresses a conversation visible in another tab", () => {
    const shared = storage();
    expect(claimPanelNotification(shared, "tenant-a", "message-1", now)).toBe(true);
    expect(claimPanelNotification(shared, "tenant-a", "message-1", now + 1)).toBe(false);
    expect(claimPanelNotification(shared, "tenant-b", "message-1", now + 1)).toBe(true);
    publishPanelTabState(shared, "tenant-a", "tab-1", { visible: true, activeConversationId: "conversation-1" }, now);
    expect(conversationVisibleInAnyPanelTab(shared, "tenant-a", "conversation-1", now + 10_000)).toBe(true);
    expect(conversationVisibleInAnyPanelTab(shared, "tenant-b", "conversation-1", now + 10_000)).toBe(false);
    expect(conversationVisibleInAnyPanelTab(shared, "tenant-a", "conversation-1", now + 31_000)).toBe(false);
  });

  it("builds the top popup from the latest contact message", () => {
    expect(messageNotificationFromThread({
      conversation: {
        id: "conversation-1",
        contact_name: "Marina Costa",
        contact_phone: "5511999999999"
      },
      messages: [{
        id: "message-1",
        sender: "contact",
        content: "Olá, preciso confirmar meu horário.",
        media_type: null,
        created_at: "2026-08-03T11:59:59.000Z"
      }]
    }, now)).toEqual({
      id: "message-1",
      conversationId: "conversation-1",
      contactName: "Marina Costa",
      preview: "Olá, preciso confirmar meu horário."
    });
  });

  it("uses the CRM media label and ignores stale contact messages", () => {
    expect(messageNotificationFromThread({
      conversation: {
        id: "conversation-2",
        contact_name: null,
        contact_phone: "5511987654321"
      },
      messages: [{
        id: "message-2",
        sender: "contact",
        content: "",
        media_type: "audio",
        created_at: "2026-08-03T11:59:59.000Z"
      }]
    }, now)?.preview).toBe("[mídia]");

    expect(messageNotificationFromThread({
      conversation: {
        id: "conversation-3",
        contact_name: "Rafael Lima",
        contact_phone: "5511976543210"
      },
      messages: [
        {
          id: "message-3",
          sender: "contact",
          content: "Mensagem antiga",
          media_type: null,
          created_at: "2026-08-03T11:55:00.000Z"
        },
        {
          id: "message-4",
          sender: "human",
          content: "Resposta do atendente",
          media_type: null,
          created_at: "2026-08-03T12:00:00.000Z"
        }
      ]
    }, now)).toBeNull();
  });
});
