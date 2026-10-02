// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HelpHint } from "@/components/ui/help-hint";
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("Escape cancels an outstanding mouse hover timer", () => {
  vi.useFakeTimers();
  render(<HelpHint label="Ajuda de auditoria">Corpo da ajuda</HelpHint>);
  const button = screen.getByRole("button", { name: "Ajuda de auditoria" });
  const pointer = new MouseEvent("pointerover", { bubbles: true });
  Object.defineProperty(pointer, "pointerType", { value: "mouse" });
  fireEvent(button, pointer);
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  fireEvent.click(button);
  expect(screen.getByText("Corpo da ajuda")).toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByText("Corpo da ajuda")).toBeNull();
  act(() => { vi.advanceTimersByTime(350); });
  expect(screen.queryByText("Corpo da ajuda")).toBeNull();
});
