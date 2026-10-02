// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAVE_FEEDBACK_MS, SaveButton, SaveToast, useSaveFeedback } from "@/components/ui";
import { ErrorToasts } from "@/components/error-toasts";
import { reportError } from "@/lib/error-events";
import { useFlashToast } from "@/components/ui/flash-toast";
import { StrictMode } from "react";

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    const { rerender } = render(<><ErrorToasts /><SaveToast show={false}>Perfil salvo</SaveToast></>);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<><ErrorToasts /><SaveToast show>Perfil salvo</SaveToast></>);
    expect(screen.getByRole("status").textContent).toContain("Perfil salvo");
  });
});

describe("sucesso integrado ao toast principal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
  });

  it("reset limpa apenas o token próprio e preserva erro de outra operação", () => {
    function Probe({ name }: { name: string }) {
      const save = useSaveFeedback();
      return <><button onClick={save.markDone}>{name} confirmar</button><button onClick={save.reset}>{name} reset</button><SaveToast show={save.done} token={save.toastToken}>Salvo neste alvo</SaveToast></>;
    }
    render(<><ErrorToasts /><Probe name="A" /><Probe name="B" /></>);
    fireEvent.click(screen.getByRole("button", { name: "A confirmar" }));
    fireEvent.click(screen.getByRole("button", { name: "B reset" }));
    expect(screen.getByRole("status").textContent).toContain("Salvo neste alvo");
    fireEvent.click(screen.getByRole("button", { name: "A reset" }));
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "A confirmar" }));
    act(() => reportError("Erro de outra operação"));
    fireEvent.click(screen.getByRole("button", { name: "A reset" }));
    expect(screen.getByRole("alert").textContent).toContain("Erro de outra operação");
  });

  it("preserva ReactNode sem portal próprio e erro substitui sucesso em um único renderer", () => {
    render(<><SaveToast show><span>Perfil <b>salvo</b></span></SaveToast><ErrorToasts /></>);
    expect(screen.getByRole("status").querySelector("b")?.textContent).toBe("salvo");
    expect(document.querySelectorAll(".error-toast")).toHaveLength(1);
    expect(document.querySelector(".save-toast-layer, .on-toast")).toBeNull();
    act(() => reportError("Falha posterior"));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Falha posterior");
    expect(document.querySelectorAll(".error-toast")).toHaveLength(1);
  });

  it("StrictMode não duplica confirmação e mantém sua expiração", () => {
    render(<StrictMode><ErrorToasts /><SaveToast show>Sucesso estrito</SaveToast></StrictMode>);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    act(() => vi.advanceTimersByTime(SAVE_FEEDBACK_MS));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("dois sucessos diferentes no mesmo commit deixam apenas o último aviso", () => {
    render(<><ErrorToasts /><SaveToast show>Primeiro sucesso</SaveToast><SaveToast show>Segundo sucesso</SaveToast></>);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toContain("Segundo sucesso");
    expect(screen.queryByText("Primeiro sucesso")).toBeNull();
  });

  it("sucessos simultâneos substituem o anterior e show false/unmount não apagam a confirmação", () => {
    const tree = (show: boolean, mounted = true) => <><ErrorToasts />{mounted ? <SaveToast show={show}>Contato criado</SaveToast> : null}</>;
    const view = render(tree(true));
    view.rerender(tree(false));
    expect(screen.getByRole("status").textContent).toContain("Contato criado");
    view.rerender(tree(false, false));
    expect(screen.getByRole("status").textContent).toContain("Contato criado");
    act(() => vi.advanceTimersByTime(SAVE_FEEDBACK_MS));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("remount de show true não reapresenta sucesso antigo nem substitui erro; false→true é nova ação", () => {
    const tree = (show: boolean, key: string) => <><ErrorToasts /><SaveToast key={key} show={show}><span>Perfil <b>atualizado</b></span></SaveToast></>;
    const view = render(tree(true, "primeiro"));
    act(() => reportError("Erro preservado"));
    view.rerender(tree(true, "segundo"));
    expect(screen.getByRole("alert").textContent).toContain("Erro preservado");
    view.rerender(tree(false, "segundo"));
    view.rerender(tree(true, "segundo"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Perfil atualizado");
  });

  it("render e children novos enquanto show true não reiniciam nem republicam sucesso expirado", () => {
    const tree = () => <><ErrorToasts /><SaveToast show><span>Sucesso <b>estável</b></span></SaveToast></>;
    const view = render(tree());
    act(() => vi.advanceTimersByTime(2_000));
    view.rerender(tree());
    act(() => vi.advanceTimersByTime(600));
    expect(screen.queryByRole("status")).toBeNull();
    view.rerender(tree());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("deduplica dois SaveToast iguais, permite dismiss e não reaparece no remount", () => {
    const tree = (key: string) => <><ErrorToasts /><SaveToast key={key} show>Salvo uma vez</SaveToast><SaveToast show>Salvo uma vez</SaveToast></>;
    const view = render(tree("a"));
    expect(screen.getAllByRole("status")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Fechar aviso" }));
    view.rerender(tree("b"));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("FlashToast publica no principal, reinicia prazo na nova ação e clear não remove um erro posterior", () => {
    function Probe() {
      const flash = useFlashToast();
      return <><button onClick={() => flash.show("Tarefa concluída")}>ok</button><button onClick={flash.clear}>limpar</button>{flash.toast}</>;
    }
    render(<><ErrorToasts /><Probe /></>);
    fireEvent.click(screen.getByRole("button", { name: "ok" }));
    expect(screen.getByRole("status").textContent).toContain("Tarefa concluída");
    act(() => vi.advanceTimersByTime(2_500));
    fireEvent.click(screen.getByRole("button", { name: "ok" }));
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole("status")).toBeTruthy();
    expect(document.querySelectorAll(".error-toast")).toHaveLength(1);
    act(() => reportError("Falha após flash"));
    fireEvent.click(screen.getByRole("button", { name: "limpar" }));
    expect(screen.getByRole("alert").textContent).toContain("Falha após flash");
    fireEvent.click(screen.getByRole("button", { name: "ok" }));
    fireEvent.click(screen.getByRole("button", { name: "limpar" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
