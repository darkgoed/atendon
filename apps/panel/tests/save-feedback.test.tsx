// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SAVE_FEEDBACK_MS, SaveButton, SaveToast, useSaveFeedback } from "@/components/ui";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("padrão de salvar (DS v2 §2)", () => {
  it("idle → busy → done → idle após 2,6s", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSaveFeedback());
    expect(result.current.state).toBe("idle");
    let resolve!: () => void;
    let pending!: Promise<void>;
    act(() => { pending = result.current.run(() => new Promise<void>((r) => { resolve = r; })); });
    expect(result.current.state).toBe("busy");
    await act(async () => { resolve(); await pending; });
    expect(result.current.state).toBe("done");
    act(() => { vi.advanceTimersByTime(SAVE_FEEDBACK_MS); });
    expect(result.current.state).toBe("idle");
  });

  it("falha volta para idle e repropaga o erro", async () => {
    const { result } = renderHook(() => useSaveFeedback());
    let caught: unknown = null;
    await act(async () => {
      await result.current.run(async () => { throw new Error("boom"); }).catch((error) => { caught = error; });
    });
    expect((caught as Error).message).toBe("boom");
    expect(result.current.state).toBe("idle");
  });

  it("SaveButton troca rótulo e ícone por estado e trava o clique em busy", () => {
    const onClick = vi.fn();
    const { rerender } = render(<SaveButton state="idle" onClick={onClick}>Salvar perfil</SaveButton>);
    const button = screen.getByRole("button", { name: "Salvar perfil" });
    expect(button.className).toContain("primary");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(<SaveButton state="busy" onClick={onClick}>Salvar perfil</SaveButton>);
    expect(screen.getByRole("button", { name: "Salvando…" }).hasAttribute("disabled")).toBe(true);
    expect(document.querySelector(".on-spinner")).toBeTruthy();

    rerender(<SaveButton state="done" onClick={onClick}>Salvar perfil</SaveButton>);
    expect(screen.getByRole("button", { name: "Salvo" })).toBeTruthy();
    expect(document.querySelector(".on-check path")?.getAttribute("d")).toBe("M20 6 9 17l-5-5");
  });

  it("SaveToast só aparece em show e anuncia como status", () => {
    const { rerender } = render(<SaveToast show={false}>Perfil salvo</SaveToast>);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<SaveToast show>Perfil salvo</SaveToast>);
    expect(screen.getByRole("status").textContent).toContain("Perfil salvo");
  });
});
