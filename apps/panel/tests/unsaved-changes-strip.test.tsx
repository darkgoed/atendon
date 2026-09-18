// @vitest-environment jsdom
// R18 — strip "Alterações não salvas": fixa, discreta, sem modais; Ver
// alterações expande diff resumido; Descartar/Salvar são slots de ação.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnsavedChangesStrip } from "@/components/unsaved-changes-strip";

afterEach(() => cleanup());

describe("UnsavedChangesStrip", () => {
  it("renders nothing when inactive", () => {
    const { container } = render(
      <UnsavedChangesStrip active changes={[]} onDiscard={vi.fn()} onSave={vi.fn()} />
    );
    expect(screen.getByRole("region", { name: "Alterações não salvas" })).toBeTruthy();
    expect(container.querySelector("button")).toBeTruthy();

    const inactive = render(
      <UnsavedChangesStrip active={false} changes={[]} onDiscard={vi.fn()} onSave={vi.fn()} />
    );
    expect(inactive.container.querySelector("button")).toBeNull();
    inactive.unmount();
  });

  it("exposes message, discard and save action slots", () => {
    const onDiscard = vi.fn();
    const onSave = vi.fn();
    render(
      <UnsavedChangesStrip
        active
        changes={[{ label: "Nome", before: "Ana", after: "Ana Souza" }]}
        onDiscard={onDiscard}
        onSave={onSave}
      />
    );
    expect(screen.getByText("Alterações não salvas")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("expands the summarized diff in a popover, no modals involved", () => {
    render(
      <UnsavedChangesStrip
        active
        changes={[
          { label: "Nome", before: "Ana", after: "Ana Souza" },
          { label: "Telefone", before: "11999990000", after: "11988887777" }
        ]}
        onDiscard={vi.fn()}
        onSave={vi.fn()}
      />
    );
    const toggle = screen.getByRole("button", { name: "Ver alterações" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Ana Souza")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText("Ana Souza")).toBeTruthy();
    expect(screen.getByText("11988887777")).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Ocultar alterações" })).toBeTruthy();
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("hides the diff toggle without changes and shows the saving state", () => {
    render(<UnsavedChangesStrip active changes={[]} onDiscard={vi.fn()} onSave={vi.fn()} saving />);
    expect(screen.queryByRole("button", { name: "Ver alterações" })).toBeNull();
    expect(screen.getByRole("button", { name: "Salvando…" })).toBeTruthy();
  });
});
