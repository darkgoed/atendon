// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Sparkline } from "@/components/commercial-dashboard-charts";
import { KpiCard } from "@/components/ui/kpi";

// O arquivo é .test.ts (contrato da SPEC), então JSX não está disponível —
// os componentes são montados com React.createElement.

afterEach(cleanup);

const h = React.createElement;

describe("Sparkline", () => {
  it("não renderiza nada para séries sem dados (vazia, zeros ou valor único)", () => {
    const empty = render(h(Sparkline, { values: [] }));
    expect(empty.container.querySelector("svg")).toBeNull();
    cleanup();
    const zeros = render(h(Sparkline, { values: [0, 0] }));
    expect(zeros.container.querySelector("svg")).toBeNull();
    cleanup();
    const single = render(h(Sparkline, { values: [5] }));
    expect(single.container.querySelector("svg")).toBeNull();
  });

  it("renderiza um svg com gradiente para séries com 3+ valores", () => {
    const { container } = render(h(Sparkline, { values: [2, 5, 3, 8] }));
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("linearGradient")).not.toBeNull();
    expect(container.querySelectorAll("path").length).toBeGreaterThanOrEqual(2);
  });
});

describe("KpiCard", () => {
  it("com spark, renderiza valor e sparkline no mesmo card, em linha (row)", () => {
    const { container } = render(
      h(KpiCard, { label: "Agendamentos", value: "42", hint: "reuniões marcadas", spark: h(Sparkline, { values: [1, 4, 2, 6], className: "h-14 w-full" }) })
    );
    const card = container.querySelector(".kpi-card");
    expect(card).not.toBeNull();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeNull();
    const row = card!.querySelector(".kpi-card__dd > div");
    expect(row).not.toBeNull();
    expect(row!.className).toContain("flex");
    expect(row!.className).toContain("items-end");
  });

  it("sem spark, mantém a marcação atual (body/hint como antes, sem row)", () => {
    const { container } = render(h(KpiCard, { label: "Vendas", value: "7", hint: "fechamentos" }));
    const dd = container.querySelector(".kpi-card__dd")!;
    expect(dd.firstElementChild!.className).toBe("kpi-card__body");
    expect(container.querySelector("svg")).toBeNull();
    expect(dd.querySelector(".kpi-card__hint")).toHaveTextContent("fechamentos");
  });
});

describe("source assertions — Visão geral de referência", () => {
  let source = "";

  beforeAll(async () => {
    // Em jsdom o import.meta.url é http — resolve pelo cwd do painel.
    source = await readFile(resolve(process.cwd(), "components/dashboard-reference-overview.tsx"), "utf8");
  });

  it("mantém o funil definitivo com os estágios e as taxas do funil", () => {
    expect(source).toContain("Funil de conversão");
    for (const stage of ["Novos contatos", "Agendamentos", "Calls realizadas", "Vendas"]) {
      expect(source).toContain(stage);
    }
    for (const step of ["Lead → Agendamento", "Agendamento → Comparecimento", "Call → Venda", "Lead → Venda", "Taxa de no-show"]) {
      expect(source).toContain(step);
    }
  });

  it("cobre os grupos do board antigo com seções próprias", () => {
    for (const section of ["Atendimento", "Agenda de hoje", "Handoffs aguardando", "Alertas recentes", "Pipeline", "Origem dos leads", "Vendas por origem", "Equipe"]) {
      expect(source).toContain(section);
    }
  });

  it("não depende mais do funil antigo nem da biblioteca de widgets", async () => {
    expect(source).not.toContain("components/ui/funnel");
    const widgetsPage = await readFile(resolve(process.cwd(), "components/dashboard-widgets.tsx"), "utf8");
    expect(widgetsPage).toContain("<DashboardReferenceOverview");
    expect(widgetsPage).not.toContain("Biblioteca de widgets");
    expect(widgetsPage).not.toContain("Personalizar");
  });
});
