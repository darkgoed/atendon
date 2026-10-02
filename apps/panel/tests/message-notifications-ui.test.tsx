// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeSignal } from "@/lib/realtime";
import type { PanelNotificationPreferencesResponse } from "@/lib/message-notifications";

const mocks = vi.hoisted(() => ({
  api: vi.fn(), sound: vi.fn(), router: { push: vi.fn() }, pathname: "/conversas",
  signal: undefined as ((signal: RealtimeSignal) => void) | undefined,
  config: { preferences: { enabled: true, visual_enabled: true, sound_enabled: true, sound_key: "bell", volume: 35 }, muted_conversations: [] } as PanelNotificationPreferencesResponse
}));
vi.mock("@/lib/api", () => ({ api: mocks.api }));
vi.mock("@/lib/notification-sounds", () => ({ playNotificationSound: mocks.sound }));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname, useRouter: () => mocks.router }));
vi.mock("swr", () => ({ default: (key: string | null) => ({ data: key === "/feature-flags" ? { flags: { conversations_delta_v2: true } } : key ? mocks.config : undefined }) }));
vi.mock("@/lib/realtime", () => ({ useRealtimeSignals: ({ onSignal }: { onSignal: (signal: RealtimeSignal) => void }) => { mocks.signal = onSignal; } }));

import { ErrorToasts } from "@/components/error-toasts";
import { MessageNotifications } from "@/components/message-notifications";
import { SaveToast } from "@/components/ui/save-feedback";
import * as notices from "@/lib/error-events";
import { useLeaveGuard } from "@/lib/leave-guard";
import { claimPanelNotification, publishPanelTabState } from "@/lib/message-notifications";

function thread(id = "message-1") {
  return { conversation: { id: "conv-2", contact_name: "Maria", contact_phone: "5511999999999" }, messages: [
    { id, sender: "contact", content: "Preciso de ajuda", media_type: null, created_at: new Date().toISOString() }
  ] };
}
async function signal() {
  await act(async () => { mocks.signal?.({ type: "conversation.messages.changed", conversationId: "conv-2" }); });
}
function mount(onOpenConversation = vi.fn()) {
  render(<StrictMode><ErrorToasts /><MessageNotifications enabled tenantId="tenant-1" activeConversationId="conv-1" onOpenConversation={onOpenConversation} /></StrictMode>);
  return onOpenConversation;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  mocks.api.mockReset().mockImplementation(async () => thread());
  mocks.sound.mockReset();
  mocks.router.push.mockReset();
  mocks.pathname = "/conversas";
  mocks.signal = undefined;
  mocks.config = { preferences: { enabled: true, visual_enabled: true, sound_enabled: true, sound_key: "bell", volume: 35 }, muted_conversations: [] };
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
});
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const action = () => screen.getByRole("button", { name: "Abrir conversa com Maria: Preciso de ajuda" });

describe("nova mensagem no singleton principal", () => {
  it("substitui sucesso/erro, não tem renderer local e abre pelo callback da conversa com dismiss", async () => {
    const onOpen = mount();
    act(() => notices.reportError("Falha anterior"));
    await signal();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("status").querySelector("strong:last-child")).toHaveTextContent("Maria");
    expect(document.querySelectorAll(".error-toast")).toHaveLength(1);
    expect(document.querySelector(".message-toast-region, .save-toast-layer, .on-toast")).toBeNull();
    expect(mocks.sound).toHaveBeenCalledWith("bell", 35);
    fireEvent.click(action());
    expect(onOpen).toHaveBeenCalledWith("conv-2");
    expect(mocks.router.push).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
    render(<SaveToast show>Sucesso seguinte</SaveToast>);
    expect(document.querySelectorAll(".error-toast")).toHaveLength(1);
    mocks.api.mockResolvedValue(thread("message-2"));
    await signal();
    expect(screen.queryByText("Sucesso seguinte")).toBeNull();
    act(() => notices.reportError("Erro seguinte"));
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.querySelectorAll(".error-toast")).toHaveLength(1);
  });

  it("ação rica sobrevive a foco por 8s e usa router fora do inbox", async () => {
    mocks.pathname = "/contatos";
    mount();
    await signal();
    act(() => vi.advanceTimersByTime(3_000));
    act(() => action().focus());
    act(() => vi.advanceTimersByTime(8_000));
    expect(action()).toHaveFocus();
    fireEvent.click(action());
    expect(mocks.router.push).toHaveBeenCalledWith("/conversas?id=conv-2");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("recusar sair conserva o toast e o rascunho; aceitar navega antes do dismiss", async () => {
    function DraftGuard() { useLeaveGuard("Descartar rascunho?"); return null; }
    mocks.pathname = "/contatos";
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<DraftGuard />);
    const onOpen = mount();
    await signal();
    const toast = screen.getByRole("status");
    fireEvent.click(action());
    expect(confirm).toHaveBeenCalledWith("Descartar rascunho?");
    expect(mocks.router.push).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toBe(toast);
    mocks.router.push.mockImplementationOnce(() => expect(screen.getByRole("status")).toBe(toast));
    confirm.mockReturnValue(true);
    fireEvent.click(action());
    expect(mocks.router.push).toHaveBeenCalledWith("/conversas?id=conv-2");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("token da ação antiga não fecha erro que substituiu a mensagem", async () => {
    const publisher = vi.spyOn(notices, "reportToast");
    const onOpen = mount();
    await signal();
    const node = publisher.mock.calls[0][0] as ReactElement<{ onClick: () => void }>;
    act(() => notices.reportError("Erro preservado"));
    act(() => node.props.onClick());
    expect(onOpen).toHaveBeenCalledWith("conv-2");
    expect(screen.getByRole("alert")).toHaveTextContent("Erro preservado");
  });

  it("deduplica realtime e entre abas sem repetir som ou substituir um aviso posterior", async () => {
    mount();
    await signal();
    act(() => notices.reportError("Falha preservada na repetição"));
    await signal();
    expect(mocks.sound).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Falha preservada na repetição");
    mocks.api.mockResolvedValue(thread("claimed-message"));
    claimPanelNotification(localStorage, "tenant-1", "claimed-message");
    await signal();
    expect(mocks.sound).toHaveBeenCalledTimes(1);
  });

  it.each(["disabled", "muted", "visible"])("preserva bloqueio %s de som e toast", async (mode) => {
    if (mode === "disabled") mocks.config.preferences.enabled = false;
    if (mode === "muted") mocks.config.muted_conversations = [{ id: "conv-2", contact_name: "Maria", contact_phone: "55", muted_at: new Date().toISOString() }];
    if (mode === "visible") publishPanelTabState(localStorage, "tenant-1", "other-tab", { visible: true, activeConversationId: "conv-2" });
    mount();
    await signal();
    expect(screen.queryByRole("status")).toBeNull();
    expect(mocks.sound).not.toHaveBeenCalled();
  });

  it("visual disabled mantém som, sound disabled mantém aviso", async () => {
    mocks.config.preferences.visual_enabled = false;
    mount();
    await signal();
    expect(screen.queryByRole("status")).toBeNull();
    expect(mocks.sound).toHaveBeenCalledTimes(1);
    mocks.config.preferences.visual_enabled = true;
    mocks.config.preferences.sound_enabled = false;
    mocks.api.mockResolvedValue(thread("message-silent"));
    await signal();
    expect(action()).toBeInTheDocument();
    expect(mocks.sound).toHaveBeenCalledTimes(1);
  });

  it("preserva desktop em aba oculta, preferências, tag, silêncio e navegação", async () => {
    const close = vi.fn();
    const desktop: { onclick?: () => void } = {};
    const native = vi.fn(function () { return Object.assign(desktop, { close }); });
    Object.assign(native, { permission: "granted" });
    vi.stubGlobal("Notification", native);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    vi.spyOn(window, "focus").mockImplementation(() => undefined);
    mount();
    await signal();
    expect(native).toHaveBeenCalledWith("Maria", { body: "Preciso de ajuda", tag: "atendon-message-tenant-1-message-1", silent: true });
    act(() => desktop.onclick?.());
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(mocks.router.push).toHaveBeenCalledWith("/conversas?id=conv-2");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
