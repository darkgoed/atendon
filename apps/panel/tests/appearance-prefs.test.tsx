// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearancePreferences } from "@/components/appearance-preferences";
import {
  applyAppearanceToDocument,
  hydrateAppearance,
  readStoredAppearance
} from "@/lib/appearance";

function patchBodies(): unknown[] {
  return apiMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

function waitForPATCH(): Promise<void> {
  return waitFor(() => {
    expect(patchBodies().length).toBeGreaterThan(0);
  });
}

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMock }));

beforeEach(() => {
  apiMock.mockReset();
  localStorage.clear();
  const root = document.documentElement;
  root.removeAttribute("data-accent");
  root.removeAttribute("data-density");
  root.dataset.theme = "dark";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("preferências de aparência (R16)", () => {
  it("aplica data-accent/data-density no <html> a partir da API e persiste em localStorage", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return { theme: null, accent: "green", density: "compact" };
      return { theme: null, accent: "green", density: "compact" };
    });
    await act(async () => {
      await hydrateAppearance();
    });
    expect(document.documentElement.getAttribute("data-accent")).toBe("green");
    expect(document.documentElement.getAttribute("data-density")).toBe("compact");
    expect(readStoredAppearance(localStorage)).toMatchObject({ accent: "green", density: "compact" });
  });

  it("falla silenciosamente para o localStorage quando a API 404", async () => {
    localStorage.setItem("atendon-appearance", JSON.stringify({ theme: null, accent: "violet", density: "compact" }));
    apiMock.mockRejectedValue(new Error("404"));
    await act(async () => {
      await hydrateAppearance();
    });
    expect(document.documentElement.getAttribute("data-accent")).toBe("violet");
    expect(document.documentElement.getAttribute("data-density")).toBe("compact");
  });

  it("aplica data-density=compact no <html> e manda o PATCH (contrato appearance-preferences)", async () => {
    apiMock.mockImplementation(async () => ({ theme: null, accent: null, density: null }));
    render(<AppearancePreferences />);
    fireEvent.click(screen.getByRole("button", { name: "Compacta" }));
    expect(document.documentElement.getAttribute("data-density")).toBe("compact");
    expect(JSON.parse(localStorage.getItem("atendon-appearance") ?? "{}")).toMatchObject({ density: "compact" });
    await waitForPATCH();
    expect(patchBodies()).toContainEqual({ density: "compact" });
  });

  it("aplica data-accent ao escolher um preset", async () => {
    apiMock.mockImplementation(async () => ({ theme: null, accent: null, density: null }));
    render(<AppearancePreferences />);
    fireEvent.click(screen.getByRole("button", { name: "Verde" }));
    expect(document.documentElement.getAttribute("data-accent")).toBe("green");
    await waitForPATCH();
    expect(patchBodies()).toContainEqual({ accent: "green" });
  });

  it("aplica accent null removendo o atributo (voltar ao padrão azul)", () => {
    applyAppearanceToDocument(document.documentElement, { accent: "violet", density: "compact" });
    expect(document.documentElement.getAttribute("data-accent")).toBe("violet");
    applyAppearanceToDocument(document.documentElement, { accent: null, density: null });
    expect(document.documentElement.hasAttribute("data-accent")).toBe(false);
    expect(document.documentElement.hasAttribute("data-density")).toBe(false);
  });

  it("troca o tema com a onda do ThemeToggle e persiste o tema escolhido", async () => {
    apiMock.mockImplementation(async () => ({ theme: null, accent: null, density: null }));
    vi.useFakeTimers();
    try {
      render(<AppearancePreferences />);
      fireEvent.click(screen.getByRole("button", { name: "Claro" }));
      await act(async () => {
        vi.advanceTimersByTime(1200);
        await Promise.resolve();
      });
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
      expect(localStorage.getItem("atendon-theme")).toBe("light");
    } finally {
      vi.useRealTimers();
    }
  });
});