// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorToasts } from "@/components/error-toasts";
import { api } from "@/lib/api";
import { ERROR_TOAST_EVENT, reportError, reportToast } from "@/lib/error-events";
import { WHATSAPP_DISCONNECTED_MESSAGE } from "@/lib/whatsapp-support";
import { StrictMode } from "react";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
});

afterEach(async () => {
  cleanup();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const notify = (message: string) => act(() => reportError(message));

describe("toast principal", () => {
  it("pausa o alerta operacional durante foco e retoma somente o tempo restante", () => {
    render(<StrictMode><ErrorToasts /></StrictMode>);
    act(() => reportToast("Conexão em atenção", { kind: "operational" }));
    act(() => vi.advanceTimersByTime(7_000));
    const link = screen.getByRole("link", { name: "Revisar na central" });
    act(() => link.focus());
    act(() => vi.advanceTimersByTime(8_000));
    expect(link).toHaveFocus();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    act(() => link.blur());
    act(() => vi.advanceTimersByTime(999));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("hover e focus-within sobrepostos só retomam depois de ambos saírem, inclusive foco interno", () => {
    render(<ErrorToasts />);
    act(() => reportToast(<><button>Primeira ação</button><button>Segunda ação</button></>, { kind: "info" }));
    act(() => vi.advanceTimersByTime(6_000));
    fireEvent.pointerEnter(screen.getByRole("status"));
    const first = screen.getByRole("button", { name: "Primeira ação" });
    const second = screen.getByRole("button", { name: "Segunda ação" });
    act(() => first.focus());
    fireEvent.pointerLeave(screen.getByRole("status"));
    act(() => vi.advanceTimersByTime(8_000));
    act(() => second.focus());
    act(() => vi.advanceTimersByTime(8_000));
    expect(second).toHaveFocus();
    fireEvent.pointerEnter(screen.getByRole("status"));
    act(() => second.blur());
    act(() => vi.advanceTimersByTime(8_000));
    expect(screen.getByRole("status")).toBeInTheDocument();
    fireEvent.pointerLeave(screen.getByRole("status"));
    act(() => vi.advanceTimersByTime(1_999));
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("substituição enquanto pausado cancela o tempo antigo e dá prazo próprio ao novo aviso", () => {
    render(<ErrorToasts />);
    notify("Aviso pausado");
    act(() => vi.advanceTimersByTime(7_000));
    fireEvent.pointerEnter(screen.getByRole("alert"));
    act(() => vi.advanceTimersByTime(8_000));
    act(() => reportToast("Sucesso substituto", { kind: "success" }));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => vi.advanceTimersByTime(2_599));
    expect(screen.getByRole("status")).toHaveTextContent("Sucesso substituto");
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("info e warning usam a mesma superfície com live region da severidade", () => {
    render(<ErrorToasts />);
    act(() => reportToast("Informação contextual", { kind: "info" }));
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    act(() => reportToast("Aviso temporário", { kind: "warning" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
    expect(document.querySelectorAll(".error-toast")).toHaveLength(1);
  });

  it("substitui o aviso atual em vez de empilhar e cancela o timer anterior", async () => {
    render(<ErrorToasts />);
    notify("Primeira falha");
    await act(async () => { await vi.advanceTimersByTimeAsync(7_000); });
    notify("Segunda falha");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText("Primeira falha")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_001); });
    expect(screen.getByText("Segunda falha")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(6_999); });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("deduplica o aviso visível sem prolongar o timer; depois de fechado permite nova tentativa", async () => {
    render(<ErrorToasts />);
    notify("Falha repetida");
    await act(async () => { await vi.advanceTimersByTimeAsync(7_000); });
    notify("Falha repetida");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.queryByRole("alert")).toBeNull();
    notify("Falha repetida");
    expect(screen.getByText("Falha repetida")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fechar aviso de erro" }));
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    notify("Falha repetida");
    expect(screen.getByText("Falha repetida")).toBeInTheDocument();
  });

  it("ignora resets locais vazios e conserva a ajuda de reconexão do WhatsApp", () => {
    render(<ErrorToasts />);
    notify(WHATSAPP_DISCONNECTED_MESSAGE);
    notify("");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Enviar mensagem para suporte" })).toHaveAttribute("href", expect.stringContaining("wa.me/"));
  });

  it("recebe erros do browser e rejeições não tratadas no mesmo lugar", () => {
    render(<ErrorToasts />);
    act(() => window.dispatchEvent(new ErrorEvent("error", { error: new Error("Erro do navegador") })));
    expect(screen.getByText("Erro do navegador")).toBeInTheDocument();
    const rejected = new Event("unhandledrejection");
    Object.defineProperty(rejected, "reason", { value: new Error("Rejeição não tratada") });
    act(() => window.dispatchEvent(rejected));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("Rejeição não tratada")).toBeInTheDocument();
  });

  it("publica uma só vez a mesma falha da API encaminhada pelo catch local", async () => {
    const reported = vi.fn();
    window.addEventListener(ERROR_TOAST_EVENT, reported);
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: "Erro de operação" }, { status: 502 }));
    try {
      await api("/test-error").catch((error: Error) => reportError(error.message));
      expect(reported).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(ERROR_TOAST_EVENT, reported);
    }
  });

  it("mantém todos os avisos operacionais do lote em um toast e deduplica IDs na próxima coleta", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/me")) return Response.json({
        actorScope: "root", rootWorkspaceAccess: true, user: { isRoot: true },
        activeWorkspace: { id: "workspace-1" }, permissions: []
      });
      if (url.endsWith("/feature-flags")) return Response.json({ flags: { alerts_delivery_v2: true } });
      return Response.json({ alerts: [
        { id: "alert-1", message: "Conexão interrompida" },
        { id: "alert-2", message: "Cobrança pendente" },
        { id: "alert-hidden", message: "Somente na central", should_toast: false }
      ] });
    });
    render(<ErrorToasts />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Conexão interrompida");
    expect(screen.getByRole("alert")).toHaveTextContent("Cobrança pendente");
    expect(screen.queryByText("Somente na central")).toBeNull();
    expect(screen.getByRole("link", { name: "Revisar na central" })).toHaveAttribute("href", "/alertas");
    await act(async () => { await vi.advanceTimersByTimeAsync(8_001); });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("remove listeners e timers do toast no unmount", async () => {
    const view = render(<ErrorToasts />);
    notify("Aviso antes de desmontar");
    view.unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    notify("Aviso depois de desmontar");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
