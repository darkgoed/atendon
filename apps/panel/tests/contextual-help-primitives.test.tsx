// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Field, HelpHint, IconButton, Input, Select, Textarea, Tooltip, useFlashToast } from "@/components/ui";
import { ErrorToasts } from "@/components/error-toasts";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// Radix Popper mede o balão com ResizeObserver, ausente no jsdom.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

describe("primitivos de ajuda contextual", () => {
  it("HelpHint abre no hover e foco, sem botão extra ou cabeçalho", async () => {
    const user = userEvent.setup();
    render(<h1><HelpHint content="Quanto o robô aguarda." description="Quanto o robô aguarda antes de seguir.">Tempo de espera</HelpHint></h1>);
    const trigger = screen.getByText("Tempo de espera");
    expect(screen.getByRole("heading", { name: "Tempo de espera" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(trigger).toHaveAccessibleDescription("Quanto o robô aguarda antes de seguir.");
    await user.hover(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Quanto o robô aguarda.");
    expect(document.querySelector(".tooltip--compact strong, .tooltip--compact svg")).toBeNull();
    await user.unhover(trigger);
    await user.tab();
    expect(trigger).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Quanto o robô aguarda.");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(trigger).toHaveAccessibleDescription("Quanto o robô aguarda antes de seguir.");
  });

  it.each([Input, Select, Textarea])("Field mostra ajuda no rótulo e controle sem alterar nome ou descrição", async (Control) => {
    const user = userEvent.setup();
    render(<><span id="existing">Descrição anterior.</span><Field label="Motivo" help="Aparece no histórico do lead." hint="Opcional"><Control aria-describedby="existing" /></Field></>);
    const control = screen.getByLabelText("Motivo");
    expect(control).toHaveAccessibleName("Motivo");
    expect(control).toHaveAccessibleDescription("Descrição anterior. Opcional Aparece no histórico do lead.");
    expect(screen.queryByRole("button", { name: /^Ajuda:/ })).toBeNull();
    await user.hover(screen.getByText("Motivo"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Aparece no histórico do lead.");
    await user.unhover(screen.getByText("Motivo"));
    await user.tab();
    expect(screen.getByText("Motivo")).toHaveFocus();
    await user.tab();
    expect(control).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Aparece no histórico do lead.");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("Field preserva o erro e o controle aninhado com ajuda", () => {
    render(<Field label="Motivo" help="Explicação." error="Obrigatório"><div><Input id="reason" /></div></Field>);
    const control = screen.getByRole("textbox", { name: "Motivo" });
    expect(control).toHaveAttribute("id", "reason");
    expect(control).toHaveAttribute("aria-invalid", "true");
    expect(control).toHaveAccessibleDescription("Obrigatório Explicação.");
  });

  it("IconButton usa label, helper ou title como tooltip sem title nativo e funciona no toque", async () => {
    const user = userEvent.setup();
    const clicked = vi.fn();
    const ref = React.createRef<HTMLButtonElement>();
    render(<IconButton label="Compartilhar" title="Título antigo" helper="Criar um link público" ref={ref} onClick={clicked}>↗</IconButton>);
    const control = screen.getByRole("button", { name: "Compartilhar" });
    expect(ref.current).toBe(control);
    expect(control).not.toHaveAttribute("title");
    expect(control).toHaveAccessibleDescription("Criar um link público");
    await user.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Criar um link público");
    await user.keyboard("{Escape}");
    await user.pointer([{ keys: "[TouchA>]", target: control }, { keys: "[/TouchA]", target: control }]);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("API antiga mantém orientação como texto focável, sem ?", async () => {
    const user = userEvent.setup();
    render(<HelpHint label="Ajuda: Tempo" title="Tempo">Quanto o robô aguarda.</HelpHint>);
    expect(screen.queryByRole("button")).toBeNull();
    await user.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Quanto o robô aguarda.");
  });

  it("Tooltip funciona sem TooltipProvider ancestral", () => {
    render(<Tooltip content="Arquivar conversa"><button type="button">x</button></Tooltip>);
    expect(screen.getByRole("button", { name: "x" })).toBeInTheDocument();
  });

  it("useFlashToast mostra o texto e reinicia a cada ação", () => {
    function Probe() {
      const flash = useFlashToast();
      return <><button type="button" onClick={() => flash.show("Tarefa concluída")}>ok</button>{flash.toast}</>;
    }
    render(<><ErrorToasts /><Probe /></>);
    act(() => { screen.getByRole("button", { name: "ok" }).click(); });
    expect(screen.getByRole("status")).toHaveTextContent("Tarefa concluída");
    const first = screen.getByRole("status");
    act(() => { screen.getByRole("button", { name: "ok" }).click(); });
    expect(screen.getByRole("status")).not.toBe(first);
    expect(screen.getByRole("status")).toHaveTextContent("Tarefa concluída");
    expect(document.querySelectorAll(".error-toast")).toHaveLength(1);
  });
});
