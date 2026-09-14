// Offline-only public, Meet and Tripz responses. Shapes follow panel lib contracts.
const access = { token: "qa-meet-token", room_name: "qa-room", domain: "https://meet.invalid" };
const conversation = { id: "qa-tripz-conversation", title: "Roteiro QA", status: "active", createdAt: "2026-08-20T12:00:00.000Z" };
export function publicTripzFixture(path) {
  if (path === "/invitations/qa-token") return { invitation: { token: "qa-token", workspace_name: "AtendON QA Workspace", email: "guest@example.test", status: "pending", expires_at: "2026-09-30T12:00:00.000Z", role_name: "Operador", existingUser: false } };
  if (path === "/meet/rooms/qa-room/token" || path === "/meet/join/qa-code") return { error: "provider-unavailable", message: "O provedor de videochamada está indisponível no ambiente de QA." };
  if (path === "/tripz-ai/conversations") return { conversations: [conversation], nextCursor: null };
  if (path === "/tripz-ai/conversations/qa-tripz-conversation") return conversation;
  if (path === "/tripz-ai/conversations/qa-tripz-conversation/messages") return { messages: [{ id: "qa-tripz-message", role: "assistant", content: "Roteiro QA pronto para revisão.", createdAt: "2026-08-20T12:01:00.000Z", processingStatus: "completed", metadata: {}, attachments: [] }], nextCursor: null };
  if (path === "/tripz-ai/conversations/qa-tripz-conversation/proposal") return { id: "qa-tripz-proposal", kind: "preview", status: "ready", proposalRevision: 1 };
}
