// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearancePreferences } from "@/components/appearance-preferences";
import { WebPushSettings } from "@/components/web-push-settings";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMock }));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  apiMock.mockReset();
  document.documentElement.dataset.theme = "dark";
  document.documentElement.removeAttribute("data-density");
  document.documentElement.removeAttribute("data-accent");
  (window as unknown as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
});

afterEach(() => {
  cleanup();
});

describe("ajuda contextual nas configurações", () => {
  it("explica a cadência cumulativa do follow-up da IA e preserva o rótulo", async () => {
    apiMock.mockImplementation(async (path: string) =>
      path.includes("settings")
        ? { settings: { enabled: false, delaysMinutes: [120, 1440, 4320] } }
        : { media: [] }
    );
    const { AiFollowUpSettingsPanel } = await import("@/components/ai-follow-up-settings-panel");
    render(<AiFollowUpSettingsPanel />);
    const hint = await screen.findByRole("button", { name: "Ajuda: Tentativas cumulativas" });
    expect(screen.getByText("Tentativas cumulativas")).toBeTruthy();
    fireEvent.click(hint);
    expect(await screen.findByText(/Até 10 tentativas/i)).toBeTruthy();
    expect(await screen.findByText(/43.200 minutos/i)).toBeTruthy();
  });

  it("explica o web push por dispositivo sem mudar o título da seção", async () => {
    apiMock.mockImplementation(async () => ({
      enabled: true,
      configured: true,
      public_key: "abc",
      subscription_count: 1,
      preferences: {
        web_push_enabled: true,
        push_assigned_messages: true,
        push_assignments: true,
        push_appointments: true,
        push_critical_alerts: true,
        push_other: false
      }
    }));
    render(<WebPushSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Ajuda: Web Push" }));
    expect(screen.getByRole("heading", { name: /Web Push discreto/ })).toBeTruthy();
    expect(await screen.findByText(/Cada dispositivo tem inscrição própria/i)).toBeTruthy();
  });

  it("explica tema e densidade mantendo os nomes acessíveis dos grupos", () => {
    render(<AppearancePreferences />);
    expect(screen.getByRole("button", { name: "Ajuda: Tema" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ajuda: Densidade" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Tema" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Densidade" })).toBeTruthy();
  });
});
