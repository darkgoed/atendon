// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Field, HelpHint, Input, Tooltip, useFlashToast } from "@/components/ui";

afterEach(cleanup);

// Radix Popper mede o balão com ResizeObserver, ausente no jsdom.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

describe("primitivos de ajuda contextual", () => {
  it("HelpHint abre no clique, explica e fecha com Esc", async () => {
    const user = userEvent.setup();
    render(<HelpHint label="Ajuda: Tempo de espera" title="Tempo de espera">Quanto o robô aguarda antes de seguir.</HelpHint>);
    const trigger = screen.getByRole("button", { name: "Ajuda: Tempo de espera" });
    await user.click(trigger);
    expect(await screen.findByText("Quanto o robô aguarda antes de seguir.")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Quanto o robô aguarda antes de seguir.")).toBeNull();
  });

  it("Field com help mantém o nome acessível do controle intacto", () => {
    render(<Field label="Motivo" help="Aparece no histórico do lead."><Input /></Field>);
    expect(screen.getByRole("textbox", { name: "Motivo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ajuda: Motivo" })).toBeInTheDocument();
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
    render(<Probe />);
    act(() => { screen.getByRole("button", { name: "ok" }).click(); });
    expect(screen.getByRole("status")).toHaveTextContent("Tarefa concluída");
  });
});
