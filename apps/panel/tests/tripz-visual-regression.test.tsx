// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import React, { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TripzHistorySidebar } from "../components/tripz-ai/history-sidebar";
import type { TripzConversation } from "../lib/tripz-ai";

const conversation = (status: TripzConversation["status"], id: string): TripzConversation => ({
  id,
  title: `Proposta ${id}`,
  status,
  processingStatus: "idle",
  createdAt: "2026-09-14T10:00:00.000Z",
  updatedAt: "2026-09-14T10:00:00.000Z"
});

function Harness() {
  const [open, setOpen] = useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>Abrir histórico</button>
      <TripzHistorySidebar
        conversations={[conversation("collecting", "pending"), conversation("ready_for_review", "ready"), conversation("pdf_generated", "generated")]}
        selectedId="ready"
        loading={false}
        creating={false}
        loadingMore={false}
        hasMore={false}
        mobileOpen={open}
        onCloseMobile={() => setOpen(false)}
        mobileTriggerRef={triggerRef}
        onCreate={() => undefined}
        onSelect={() => undefined}
        onDelete={() => undefined}
        onRename={async () => undefined}
        onLoadMore={() => undefined}
      />
    </div>
  );
}

describe("Tripz visual semantics and mobile history focus", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders distinct non-empty classes for pending, ready, and generated statuses", () => {
    const { container } = render(
      <TripzHistorySidebar
        conversations={[conversation("collecting", "pending"), conversation("ready_for_review", "ready"), conversation("pdf_generated", "generated")]}
        selectedId={null}
        loading={false}
        creating={false}
        loadingMore={false}
        hasMore={false}
        mobileOpen={false}
        onCloseMobile={() => undefined}
        onCreate={() => undefined}
        onSelect={() => undefined}
        onDelete={() => undefined}
        onRename={async () => undefined}
        onLoadMore={() => undefined}
      />
    );
    const marks = Array.from(container.querySelectorAll("li span[aria-hidden='true']"))
      .map((element) => element.className)
      .filter((className) => className.includes("rounded-full"));
    expect(marks).toHaveLength(3);
    expect(new Set(marks).size).toBe(3);
    expect(marks.every(Boolean)).toBe(true);
  });

  it("returns focus to the exact trigger after Escape closes the drawer", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }));
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Abrir histórico" });
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
