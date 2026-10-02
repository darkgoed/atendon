// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import { AiFollowUpSettingsPanel } from "@/components/ai-follow-up-settings-panel";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

afterEach(() => { cleanup(); apiMock.mockReset(); });

describe("regressões finais de CSS e foco da ajuda", () => {
  it("limita dimensões, hover e active ao dismiss direto sem mudar as cores por kind", () => {
    const css = readFileSync(resolve(process.cwd(), "styles/domains/feedback.css"), "utf8");
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    try {
      const rules = Array.from(style.sheet!.cssRules).filter((rule): rule is CSSStyleRule => "selectorText" in rule);
      const dismiss = rules.find((rule) => rule.selectorText === ".error-toast > button");
      expect(dismiss?.style.getPropertyValue("width")).toBe("var(--control-height-sm)");
      expect(dismiss?.style.getPropertyValue("height")).toBe("var(--control-height-sm)");
      expect(rules.some((rule) => rule.selectorText === ".error-toast > button:hover")).toBe(true);
      expect(rules.some((rule) => rule.selectorText === ".error-toast > button:active")).toBe(true);
      expect(rules.some((rule) => /^\.error-toast button(?::(?:hover|active))?$/.test(rule.selectorText))).toBe(false);
      const { container } = render(<div className="error-toast"><div className="error-toast-message"><button>Ana — Preview longo da mensagem</button></div><button>Fechar aviso</button></div>);
      expect(screen.getByRole("button", { name: "Fechar aviso" }).matches(dismiss!.selectorText)).toBe(true);
      expect(screen.getByRole("button", { name: /Ana/ }).matches(dismiss!.selectorText)).toBe(false);
      for (const [kind, color] of [["success", "success"], ["info", "primary"]]) {
        const rule = rules.find((rule) => rule.selectorText === `.error-toast[data-kind="${kind}"] :where(.error-toast-icon, .error-toast-message, button)`);
        expect(rule?.style.getPropertyValue("color")).toBe(`var(--${color}-text)`);
        container.firstElementChild!.setAttribute("data-kind", kind!);
        expect(screen.getAllByRole("button").every((button) => button.matches(rule!.selectorText))).toBe(true);
      }
    } finally {
      style.remove();
    }
  });

  it("alcança Tentativas cumulativas com Tab, preserva descrição e abre a mesma ajuda por hover e foco", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/ai-follow-ups/settings") return { settings: { enabled: false, delaysMinutes: [120, 1440, 4320] } };
      if (path === "/ai-follow-ups/media") return { media: [] };
      if (path === "/ai-stickers") return { stickers: [] };
      throw new Error(`URL inesperada: ${path}`);
    });
    const user = userEvent.setup();
    render(<SWRConfig value={{ provider: () => new Map() }}><AiFollowUpSettingsPanel /></SWRConfig>);
    const label = await screen.findByText("Tentativas cumulativas", { selector: "div.label" });
    expect(label).toHaveAttribute("tabindex", "0");
    const description = "Até 10 tentativas; a última não pode passar de 30 dias (43.200 minutos). Os atrasos precisam ser crescentes.";
    expect(label).toHaveAccessibleDescription(description);
    expect(screen.queryByRole("button", { name: /^Ajuda:/ })).toBeNull();
    await user.hover(label);
    const help = "Até 10 tentativas crescentes em até 30 dias.";
    expect(await screen.findByRole("tooltip")).toHaveTextContent(help);
    await user.unhover(label);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    await user.tab();
    expect(screen.getByRole("checkbox")).toHaveFocus();
    await user.tab();
    expect(label).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(help);
    expect(label).toHaveAccessibleDescription(description);
    await user.tab();
    expect(screen.getByRole("button", { name: "Adicionar" })).toHaveFocus();
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect(label).toHaveAccessibleDescription(description);
  });
});
