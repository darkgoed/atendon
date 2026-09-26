// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  applyThemeWithTransition,
  currentTheme,
  finishThemeTransition,
  THEME_WIPE_MS
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

type FakeTransition = {
  update: () => Promise<void> | void;
  finished: Promise<void>;
  finish: () => void;
  skipTransition: ReturnType<typeof vi.fn>;
};

/** jsdom não tem View Transition API: um fake que registra o callback e deixa
 *  o teste decidir quando o navegador "captura" e quando o wipe termina. */
function mockViewTransitions() {
  const calls: FakeTransition[] = [];
  const start = vi.fn((update: () => Promise<void> | void) => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const transition: FakeTransition = { update, finished, finish, skipTransition: vi.fn(() => finish()) };
    calls.push(transition);
    return transition;
  });
  Object.defineProperty(document, "startViewTransition", { configurable: true, writable: true, value: start });
  return { start, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.dataset.theme = "dark";
  localStorage.clear();
  mockMatchMedia(false);
});

afterEach(() => {
  finishThemeTransition();
  cleanup();
  vi.useRealTimers();
  delete (document as { startViewTransition?: unknown }).startViewTransition;
  delete document.documentElement.dataset.theme;
  document.documentElement.removeAttribute("data-theme-switching");
});

describe("transição de tema (wipe)", () => {
  it("troca o tema DENTRO da view transition e limpa o estado ao fim", async () => {
    const { start, calls } = mockViewTransitions();
    applyThemeWithTransition("light");

    expect(start).toHaveBeenCalledTimes(1);
    // Antes do callback o navegador ainda captura o snapshot antigo.
    expect(currentTheme()).toBe("dark");
    expect(document.documentElement).toHaveAttribute("data-theme-switching");

    const update = calls[0].update();
    expect(currentTheme()).toBe("light");
    expect(localStorage.getItem("atendon-theme")).toBe("light");
    await vi.advanceTimersByTimeAsync(0);
    await update;

    calls[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.documentElement).not.toHaveAttribute("data-theme-switching");
  });

  it("sem startViewTransition troca o tema na hora (fallback)", () => {
    applyThemeWithTransition("light");
    expect(currentTheme()).toBe("light");
    expect(localStorage.getItem("atendon-theme")).toBe("light");
  });

  it("respeita prefers-reduced-motion: troca na hora, sem view transition", () => {
    const { start } = mockViewTransitions();
    mockMatchMedia(true);
    applyThemeWithTransition("light");
    expect(start).not.toHaveBeenCalled();
    expect(currentTheme()).toBe("light");
  });

  it("um segundo clique no meio do wipe comita o tema pendente e pula o anterior", () => {
    const { calls } = mockViewTransitions();
    applyThemeWithTransition("light");
    applyThemeWithTransition("dark");
    expect(calls[0].skipTransition).toHaveBeenCalled();
    // O callback atrasado da primeira transição não pode desfazer a segunda.
    void calls[0].update();
    void calls[1].update();
    expect(currentTheme()).toBe("dark");
    expect(localStorage.getItem("atendon-theme")).toBe("dark");
  });

  it("startViewTransition lançando erro não perde a troca", () => {
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      writable: true,
      value: () => { throw new Error("InvalidStateError"); }
    });
    applyThemeWithTransition("light");
    expect(currentTheme()).toBe("light");
    expect(document.documentElement).not.toHaveAttribute("data-theme-switching");
  });
});

describe("ThemeToggle", () => {
  it("dispara o wipe a partir do botão e troca o ícone após o commit", async () => {
    const { start, calls } = mockViewTransitions();
    render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: "Alternar tema" });
    expect(button).toHaveAttribute("title", "Tema claro");

    // fireEvent, não user-event: user-event usa timers internos e trava com
    // vi.useFakeTimers neste cenário (o clique é síncrono, não precisa dele).
    act(() => { fireEvent.click(button); });
    expect(start).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute("data-swapping", "true");
    expect(button).toHaveAttribute("title", "Tema claro");

    await act(async () => {
      const update = calls[0].update();
      await vi.advanceTimersByTimeAsync(0);
      await update;
    });
    expect(currentTheme()).toBe("light");
    expect(button).toHaveAttribute("title", "Tema escuro");

    await act(async () => {
      calls[0].finish();
      await vi.advanceTimersByTimeAsync(THEME_WIPE_MS);
    });
    expect(button).toHaveAttribute("data-swapping", "false");
    expect(document.documentElement).not.toHaveAttribute("data-theme-switching");
  });

  it("dois toggles montados juntos sincronizam o ícone pelo data-theme", async () => {
    render(<><ThemeToggle /><ThemeToggle /></>);
    const [topbar, sidebar] = screen.getAllByRole("button", { name: "Alternar tema" });
    act(() => { fireEvent.click(topbar); });
    // O MutationObserver do jsdom entrega em microtask: deixa a fila drenar.
    await act(async () => { await Promise.resolve(); });
    expect(topbar).toHaveAttribute("title", "Tema escuro");
    expect(sidebar).toHaveAttribute("title", "Tema escuro");
  });

  it("desmontar no meio do wipe não perde o tema", () => {
    const { calls } = mockViewTransitions();
    const view = render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: "Alternar tema" });
    act(() => { fireEvent.click(button); });
    view.unmount();
    void calls[0].update();
    expect(currentTheme()).toBe("light");
  });
});
