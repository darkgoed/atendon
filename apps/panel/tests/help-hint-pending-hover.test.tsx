// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HelpHint } from "@/components/ui/help-hint";
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("Escape cancels an outstanding mouse hover timer", () => {
  vi.useFakeTimers();
  render(<HelpHint content="Corpo da ajuda" asChild><span tabIndex={0}>Auditoria</span></HelpHint>);
  const button = screen.getByText("Auditoria");
  const pointer = new MouseEvent("pointermove", { bubbles: true });
  Object.defineProperty(pointer, "pointerType", { value: "mouse" });
  fireEvent(button, pointer);
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  act(() => { vi.advanceTimersByTime(500); });
  expect(screen.queryByRole("tooltip")).toBeNull();
});
