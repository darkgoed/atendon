// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  applyThemeWithTransition,
  currentTheme,
  finishThemeTransition,
  THEME_SETTLE_MS,
  THEME_SWEEP_MS
} from "@/lib/theme-transition";

function mockMatchMedia(reduced: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: reduced && query.includes("reduce"),
      media: query,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false
    })
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.dataset.theme = "dark";
  localStorage.clear();
  mockMatchMedia(false);
  // jsdom não implementa CSS.supports; sem ele o motor cai no modo crossfade.
  Object.defineProperty(window, "CSS", { configurable: true, writable: true, value: { supports: () => true } });
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1280 });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 800 });
});

afterEach(() => {
  finishThemeTransition();
  cleanup();
  vi.useRealTimers();
  delete document.documentElement.dataset.theme;
});

describe("transição de tema", () => {
  it("cobre a tela ANTES de trocar o tema e limpa o overlay ao fim", () => {
    applyThemeWithTransition("light", { x: 100, y: 40 });

    // Durante a varredura o tema ainda é o antigo: é isso que esconde o repaint.
    const overlay = document.querySelector(".theme-fx");
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute("data-theme-fx")).toBe("light");
    expect(overlay?.getAttribute("aria-hidden")).toBe("true");
    expect(currentTheme()).toBe("dark");

    vi.advanceTimersByTime(THEME_SWEEP_MS);
    expect(currentTheme()).toBe("light");
    expect(localStorage.getItem("atendon-theme")).toBe("light");
    expect(document.querySelector(".theme-fx")?.className).toContain("theme-fx--settle");

    vi.advanceTimersByTime(THEME_SETTLE_MS);
    expect(document.querySelector(".theme-fx")).toBeNull();
  });

  it("ancora a onda no ponto clicado e cobre o canto mais distante", () => {
    applyThemeWithTransition("light", { x: 0, y: 0 });
    const overlay = document.querySelector<HTMLElement>(".theme-fx");
    expect(overlay?.style.getPropertyValue("--theme-fx-x")).toBe("0px");
    expect(overlay?.style.getPropertyValue("--theme-fx-y")).toBe("0px");
    // Diagonal de 1280x800 = 1509,3… — o raio precisa cobrir a viewport inteira.
    expect(Number.parseInt(overlay?.style.getPropertyValue("--theme-fx-r") ?? "0", 10)).toBeGreaterThanOrEqual(1509);
  });

  it("respeita prefers-reduced-motion: troca na hora, sem overlay", () => {
    mockMatchMedia(true);
    applyThemeWithTransition("light", { x: 10, y: 10 });
    expect(document.querySelector(".theme-fx")).toBeNull();
    expect(currentTheme()).toBe("light");
  });

  it("degrada para crossfade quando clip-path não é suportado (Safari antigo)", () => {
    Object.defineProperty(window, "CSS", { configurable: true, writable: true, value: { supports: () => false } });
    applyThemeWithTransition("light", { x: 10, y: 10 });
    expect(document.querySelector(".theme-fx")?.className).toContain("theme-fx--fade");
    vi.advanceTimersByTime(THEME_SWEEP_MS);
    expect(currentTheme()).toBe("light");
  });

  it("um segundo clique no meio da onda comita o tema pendente e não empilha overlays", () => {
    applyThemeWithTransition("light", { x: 10, y: 10 });
    vi.advanceTimersByTime(Math.floor(THEME_SWEEP_MS / 2));
    applyThemeWithTransition("dark", { x: 10, y: 10 });
    expect(document.querySelectorAll(".theme-fx")).toHaveLength(1);
    vi.advanceTimersByTime(THEME_SWEEP_MS + THEME_SETTLE_MS);
    expect(currentTheme()).toBe("dark");
    expect(document.querySelector(".theme-fx")).toBeNull();
  });
});

describe("ThemeToggle", () => {
  it("dispara a onda a partir do botão e troca o ícone só após o commit", async () => {
    render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: "Alternar tema" });
    expect(button).toHaveAttribute("title", "Tema claro");

    // fireEvent, não user-event: user-event usa timers internos e trava com
    // vi.useFakeTimers neste cenário (o clique é síncrono, não precisa dele).
    act(() => { fireEvent.click(button); });
    expect(button).toHaveAttribute("data-swapping", "true");
    expect(document.querySelector(".theme-fx")).not.toBeNull();
    // Durante a varredura o ícone ainda é o do tema atual.
    expect(button).toHaveAttribute("title", "Tema claro");

    act(() => { vi.advanceTimersByTime(THEME_SWEEP_MS + THEME_SETTLE_MS); });
    // O ícone segue o MutationObserver de data-theme, que entrega em microtask.
    await act(async () => { await Promise.resolve(); });
    expect(currentTheme()).toBe("light");
    expect(button).toHaveAttribute("title", "Tema escuro");
    expect(button).toHaveAttribute("data-swapping", "false");
    expect(document.querySelector(".theme-fx")).toBeNull();
  });

  it("dois toggles montados juntos sincronizam o ícone pelo data-theme", async () => {
    render(<><ThemeToggle /><ThemeToggle /></>);
    const [topbar, sidebar] = screen.getAllByRole("button", { name: "Alternar tema" });
    act(() => { fireEvent.click(topbar); });
    act(() => { vi.advanceTimersByTime(THEME_SWEEP_MS + THEME_SETTLE_MS); });
    // O MutationObserver do jsdom entrega em microtask: deixa a fila drenar.
    await act(async () => { await Promise.resolve(); });
    expect(topbar).toHaveAttribute("title", "Tema escuro");
    expect(sidebar).toHaveAttribute("title", "Tema escuro");
  });

  it("desmontar no meio da onda não deixa overlay preso nem perde o tema", () => {
    const view = render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: "Alternar tema" });
    act(() => { fireEvent.click(button); });
    view.unmount();
    expect(document.querySelector(".theme-fx")).toBeNull();
    expect(currentTheme()).toBe("light");
  });
});
