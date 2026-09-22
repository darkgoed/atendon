// Offline-only public, Meet and Tripz responses. Shapes follow panel lib contracts.
// R5: o provedor de videochamada (Jitsi) é mockado NO HARNESS — a resposta de
// token com 200 alimenta a página funcional (variante "#sucesso" dos contratos)
// e o script /external_api.js é respondido por MEET_PROVIDER_STUB_SCRIPT, que
// instala um window.JitsiMeetExternalAPI de teste. O 503 segue sendo servido
// pelo runner para o estado expected-error (comportamento correto em QA).
const access = { token: "qa-meet-token", room_name: "qa-room", domain: "http://127.0.0.1:3499" };
const conversation = { id: "qa-tripz-conversation", title: "Roteiro QA", status: "active", createdAt: "2026-08-20T12:00:00.000Z" };
// domain aponta para o PRÓPRIO baseURL: normalizeMeetOrigin exige https ou
// host localhost/127.0.0.1, e same-origin permite interceptar o external_api.js.
export const meetAccess = access;
export const MEET_PROVIDER_STUB_SCRIPT = `window.JitsiMeetExternalAPI = class {
  constructor(domain, options) {
    const parent = (options && options.parentNode) || document.body;
    const wrap = document.createElement("div");
    wrap.className = "qa-meet-stub";
    wrap.setAttribute("data-qa-meet-stub", "true");
    const title = document.createElement("p");
    title.className = "qa-meet-stub__title";
    title.textContent = "Sala QA pronta";
    const hint = document.createElement("p");
    hint.className = "qa-meet-stub__hint";
    hint.textContent = "Stub do provedor de videochamada (pre-entrada, audio/video desligados).";
    wrap.append(title, hint);
    parent.appendChild(wrap);
  }
  addListener() {}
  removeListener() {}
  dispose() {}
};`;
export function publicTripzFixture(path) {
  if (path === "/invitations/qa-token") return { invitation: { token: "qa-token", workspace_name: "AtendON QA Workspace", email: "guest@example.test", status: "pending", expires_at: "2026-09-30T12:00:00.000Z", role_name: "Operador", existingUser: false } };
  if (path === "/tripz-ai/conversations") return { conversations: [conversation], nextCursor: null };
  if (path === "/tripz-ai/conversations/qa-tripz-conversation") return conversation;
  if (path === "/tripz-ai/conversations/qa-tripz-conversation/messages") return { messages: [{ id: "qa-tripz-message", role: "assistant", content: "Roteiro QA pronto para revisão.", createdAt: "2026-08-20T12:01:00.000Z", processingStatus: "completed", metadata: {}, attachments: [] }], nextCursor: null };
  if (path === "/tripz-ai/conversations/qa-tripz-conversation/proposal") return { id: "qa-tripz-proposal", kind: "preview", status: "ready", proposalRevision: 1 };
}
