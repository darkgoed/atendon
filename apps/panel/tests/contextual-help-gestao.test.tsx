// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CommercialDashboard, type CommercialDashboardData } from "@/components/commercial-dashboard";

afterEach(cleanup);

// Radix Popover (HelpHint) mede o balão com ResizeObserver, ausente no jsdom.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const zeros = { created: 0, scheduled: 1, completed: 1, no_show: 0, cancelled: 0, upcoming: 0, overdue: 0, result_pending: 2, rescheduled: 0, proposals: 0, negotiations: 0, sales: 0, closing_rate: 0, sold_value: 0, average_ticket: 0, overdue_follow_ups: 0, attendance_rate: 50, no_show_rate: 0, average_quality: null };
const data = {
  scope: { type: "workspace", member_id: null, email: "owner@example.com", is_closer: true, is_attendant: true, availability_status: "available" },
  period: { key: "today", start: "2026-01-01", end: "2026-01-01", timezone: "UTC" },
  metrics: zeros,
  sdr_metrics: { received: 0, attended: 0, qualified: 0, scheduled: 0, qualification_rate: 0, scheduling_rate: 0, average_first_response_minutes: null, overdue_follow_ups: 0, recovered_no_shows: 0 },
  commercial_metrics: { scheduled: 0, completed: 0, attended: 0, no_show: 0, rescheduled: 0, cancelled: 0, result_pending: 0, proposals: 0, negotiations: 0, sales: 0, attendance_rate: 50, closing_rate: 0, sold_value: 0, average_ticket: 0, overdue_follow_ups: 0 },
  series: [{ day: "2026-01-01", scheduled: 1, completed: 1, no_show: 0, cancelled: 0 }],
  today_agenda: [],
  team: []
} as unknown as CommercialDashboardData;

describe("ajuda contextual no dashboard comercial (pacote gestao)", () => {
  it("HelpHint da taxa de comparecimento abre com a fórmula real do backend", async () => {
    const user = userEvent.setup();
    render(<CommercialDashboard data={data} selectedPeriod="today" customStart="2026-01-01" customEnd="2026-01-01" onPeriodChange={() => undefined} onCustomStartChange={() => undefined} onCustomEndChange={() => undefined} />);
    await user.click(screen.getByRole("button", { name: "Ajuda: Taxa comparecimento" }));
    expect(await screen.findByText(/Comparecimentos ÷ reuniões já realizadas/)).toBeInTheDocument();
  });

  it("expõe ajuda para ticket médio, fechamento e resultado pendente", () => {
    render(<CommercialDashboard data={data} selectedPeriod="today" customStart="2026-01-01" customEnd="2026-01-01" onPeriodChange={() => undefined} onCustomStartChange={() => undefined} onCustomEndChange={() => undefined} />);
    expect(screen.getByRole("button", { name: "Ajuda: Ticket médio" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ajuda: Taxa fechamento" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ajuda: Resultado pendente" })).toBeInTheDocument();
  });
});

describe("ajuda contextual nas demais telas do pacote gestao", () => {
  let home = "", widgets = "", members = "", roles = "", audit = "", uso = "", perfil = "";
  beforeAll(async () => {
    [home, widgets, members, roles, audit, uso, perfil] = await Promise.all([
      readFile(join(process.cwd(), "app/page.tsx"), "utf8"),
      readFile(join(process.cwd(), "components/dashboard-widgets.tsx"), "utf8"),
      readFile(join(process.cwd(), "app/workspace/members/content.tsx"), "utf8"),
      readFile(join(process.cwd(), "app/workspace/roles/content.tsx"), "utf8"),
      readFile(join(process.cwd(), "app/workspace/audit/content.tsx"), "utf8"),
      readFile(join(process.cwd(), "app/uso/uso-content.tsx"), "utf8"),
      readFile(join(process.cwd(), "app/perfil/page.tsx"), "utf8")
    ]);
  });

  it("mantém os pontos de ajuda adicionados em cada tela", () => {
    expect(home).toContain('HelpHint label="Ajuda: Aguardando humano"');
    expect(widgets).toContain('HelpHint label="Ajuda: Biblioteca de widgets"');
    // Resposta imediata depois de ações que antes ficavam mudas.
    expect(widgets).toContain('flash.show("Layout restaurado ao padrão")');
    expect(widgets).toContain('flash.show("Preset aplicado ao dashboard")');
    expect(members).toContain('HelpHint label="Ajuda: Validade do convite"');
    expect(members).toContain("O convite vale 7 dias");
    expect(roles).toContain('HelpHint label="Ajuda: Excluir função"');
    expect(audit).toContain('HelpHint label="Ajuda: Auditoria do workspace"');
    expect(uso).toContain('"Ajuda: Interação de IA"');
    expect(perfil).toContain('help="Ao salvar, suas outras sessões abertas são encerradas."');
  });
});
