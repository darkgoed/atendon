// @vitest-environment jsdom
import { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}

import { FlowEditor } from "@/components/flow-editor/flow-editor";
import { normalizeDefinition, validateDefinition, type FlowDefinition } from "@/components/flow-editor/flow-model";

const DEFINITION: FlowDefinition = normalizeDefinition({
  start: "M1",
  origem: "facebook",
  triggers: { ctwa: true, session_ids: [], keywords: [] },
  steps: {
    M1: { kind: "message", message: "Olá!", next: "P1" },
    P1: {
      kind: "options",
      question: "O que você quer?",
      field: "interesse",
      options: [{ value: "Opção 1" }, { value: "Outros" }],
      transitions: { "Opção 1": "E1", Outros: "E2" },
    },
    I1: {
      kind: "interactive",
      interactive_type: "buttons",
      message: "Escolha:",
      interactive_button_text: "Escolher",
      options: [{ value: "Sim" }],
      transitions: { Sim: "E1" },
    },
    E1: { kind: "final", message: "Até mais!" },
    E2: { kind: "final", message: "Obrigado!" },
  },
});

let latest: FlowDefinition = DEFINITION;

function Harness({ initial = DEFINITION }: { initial?: FlowDefinition }) {
  const [definition, setDefinition] = useState(initial);
  latest = definition;
  return (
    <FlowEditor
      flowId="fluxo"
      nome="Fluxo"
      ativo={false}
      canManage
      saving={false}
      saved={false}
      serverError={null}
      trace={null}
      definition={definition}
      onNome={() => {}}
      onDefinition={(next) => { latest = next; setDefinition(next); }}
      onSave={() => {}}
      onSimulate={() => {}}
      onCloseTrace={() => {}}
    />
  );
}

function openProperties(stepId: string) {
  fireEvent.click(screen.getByTestId(`flow-node-${stepId}`));
  return screen.getByRole("complementary", { name: "Propriedades da etapa" });
}

afterEach(() => {
  cleanup();
  latest = DEFINITION;
});

describe("editor de fluxo: rótulos de opções e botões (C8)", () => {
  it("digitar no rótulo de uma opção mantém o foco e aceita espaços", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const panel = openProperties("P1");
    const input = within(panel).getByLabelText("Opção Opção 1");
    await user.click(input);
    await user.type(input, " extra");
    expect(input).toHaveValue("Opção 1 extra");
    expect(document.activeElement).toBe(input);
    expect(latest.steps.P1.options?.[0]?.value).toBe("Opção 1 extra");
    expect(latest.steps.P1.transitions).toEqual({ "Opção 1 extra": "E1", Outros: "E2" });
  });

  it("permite limpar e redigitar o texto de um botão interativo sem perder o foco", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const panel = openProperties("I1");
    const input = within(panel).getByRole("textbox", { name: "Texto do botão Sim" });
    await user.clear(input);
    await user.type(input, "Quero agendar");
    expect(document.activeElement).toBe(input);
    expect(input).toHaveValue("Quero agendar");
    expect(latest.steps.I1.transitions).toEqual({ "Quero agendar": "E1" });
  });

  it("ao sair do campo, remove espaços das bordas; opção vazia ou repetida bloqueia o salvamento", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const panel = openProperties("P1");
    const input = within(panel).getByLabelText("Opção Opção 1");
    await user.type(input, "  ");
    await user.tab();
    expect(latest.steps.P1.options?.[0]?.value).toBe("Opção 1");
    expect(latest.steps.P1.transitions?.["Opção 1"]).toBe("E1");

    const blank = { ...DEFINITION, steps: { ...DEFINITION.steps, P1: { ...DEFINITION.steps.P1, options: [{ value: " " }, { value: "Outros" }] } } };
    expect(validateDefinition(blank).map((issue) => issue.message).join("\n")).toMatch(/opção vazia/i);
    const repeated = { ...DEFINITION, steps: { ...DEFINITION.steps, P1: { ...DEFINITION.steps.P1, options: [{ value: "Outros " }, { value: "Outros" }] } } };
    expect(validateDefinition(repeated).map((issue) => issue.message).join("\n")).toMatch(/repetida/i);
  });
});

describe("editor de fluxo: remover opção (C12)", () => {
  it("remove a opção e o destino dela", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const panel = openProperties("P1");
    await user.click(within(panel).getByRole("button", { name: "Remover opção Outros" }));
    expect(latest.steps.P1.options).toEqual([{ value: "Opção 1" }]);
    expect(latest.steps.P1.transitions).toEqual({ "Opção 1": "E1" });
    expect(within(panel).queryByRole("button", { name: /Remover opção/ })).toBeNull();
  });
});

describe("editor de fluxo: roteamento pelo teclado (C9)", () => {
  it("etapa de mensagem tem select de destino padrão que conecta e desconecta", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const panel = openProperties("M1");
    const target = within(panel).getByRole("combobox", { name: /Destino padrão/ });
    expect(target).toHaveValue("P1");
    await user.selectOptions(target, "E2");
    expect(latest.steps.M1.next).toBe("E2");
    await user.selectOptions(target, "");
    expect(latest.steps.M1.next).toBeUndefined();
  });

  it("etapa de opções tem um select de destino por opção", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const panel = openProperties("P1");
    const target = within(panel).getByRole("combobox", { name: "Destino da opção Outros" });
    expect(target).toHaveValue("E2");
    await user.selectOptions(target, "E1");
    expect(latest.steps.P1.transitions?.Outros).toBe("E1");
  });
});

describe("editor de fluxo: seleção de etapa pelo teclado (S1)", () => {
  it("Enter numa etapa focada abre as propriedades; clique alterna como antes", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const wrapper = screen.getByTestId("rf__node-M1");
    wrapper.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("complementary", { name: "Propriedades da etapa" })).toBeInTheDocument();

    cleanup();
    render(<Harness />);
    fireEvent.click(screen.getByTestId("flow-node-M1"));
    expect(screen.getByRole("complementary", { name: "Propriedades da etapa" })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("flow-node-M1"));
    expect(screen.queryByRole("complementary", { name: "Propriedades da etapa" })).toBeNull();
  });
});
