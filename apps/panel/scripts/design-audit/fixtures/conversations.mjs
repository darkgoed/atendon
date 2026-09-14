import { IDS, member } from "./session.mjs";
export const conversation = { id: IDS.conversation, contact_name: "Marina QA", contact_phone: "+55 11 99999-0001", status: "open", last_message: "Preciso confirmar o atendimento.", last_message_at: "2026-08-20T16:10:00.000Z", assigned_user_id: member.id, assigned_user_first_name: "Ana", unread_count: 2, tags: [], ai_active: false };
export const messages = [{ id: "qa-msg-1", sender: "contact", content: "Preciso confirmar o atendimento.", status: "read", created_at: "2026-08-20T16:00:00.000Z", media_type: null }, { id: "qa-msg-2", sender: "human", sender_name: "Ana QA", content: "Claro, posso ajudar.", status: "sent", created_at: "2026-08-20T16:02:00.000Z", media_type: null }];
export function conversationFixture(path) {
  if (path === "/conversations") return { conversations: [conversation], total: 1 };
  if (path.endsWith("/messages")) return { conversation, messages };
  if (path === "/conversations/unread-counts") return { human: 2, ai: 0, scheduled: 0, resolved: 0 };
  if (path === "/conversations/unread") return { conversations: [conversation] };
  if (path === `/conversations/${IDS.conversation}/read`) return {};
  if (path === "/conversation-queues" || path.startsWith("/conversation-queues?")) return { queues: [{ id: "qa-queue", name: "Atendimento QA", color: "#168aad", is_resolved: false, conversation_count: 1, archived_at: null }] };
  if (path === "/conversations/assignees") return { assignees: [member] };
  if (path.includes("/assets")) return { messages: [{ id: "qa-asset", content: "https://example.test/arquivo", media_type: "image", media_file_name: "arquivo.png" }], has_more: false, next_cursor: null };
  if (path.includes("/contact")) return { contact_name: conversation.contact_name };
}
