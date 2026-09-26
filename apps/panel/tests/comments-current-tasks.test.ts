import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { readStyleSources } from "./style-sources";

let agendaActions = "";
const readStyleSource = async () => readStyleSources();

let agendaDetail = "";
let alerts = "";
let settingsSidebar = "";
let conversations = "";
let globalStyles = "";
let rootWorkspaces = "";
let manifest = "";

beforeAll(async () => {
  [agendaActions, agendaDetail, alerts, settingsSidebar, conversations, globalStyles, rootWorkspaces, manifest] = await Promise.all([
    readFile(new URL("../app/agenda/use-agenda-actions.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/agenda/agenda-detail-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/alertas/alertas-content.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/configuracoes/settings-sidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/conversas/page.tsx", import.meta.url), "utf8"),
    readStyleSource(),
    readFile(new URL("../app/root/workspaces/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/panel-manifest.ts", import.meta.url), "utf8")
  ]);
});

describe("current comments.md tasks", () => {
  it("lets a manager change the lead responsible from the Agenda detail", () => {
    expect(agendaDetail).toContain('aria-label="Responsável do lead"');
    expect(agendaActions).toContain("saveAppointmentAssignee");
    expect(agendaActions).toContain("/assignee`");
    expect(agendaDetail).toContain("Salvar responsável");
  });

  it("removes saved views from Conversations and keeps lead cards over a white light list", () => {
    expect(conversations).not.toContain("SavedViewsControl");
    expect(conversations).not.toContain('label="Visões"');
    expect(conversations).toContain("conversation-list__item group");
    // Intenção preservada: a lista de conversas assenta sobre --surface (branco
    // no tema claro), sem override de cor literal e sem textura de fundo.
    // O `!important` saiu do CSS (era dívida), então a asserção deixou de pinar
    // a string exata; e LIGHT agora é o tema base declarado em :root — DARK é
    // que re-declara os tokens —, por isso o contrato de tema é verificado pela
    // presença dos DOIS blocos com o mesmo vocabulário, não por um seletor fixo.
    expect(globalStyles).toMatch(/\.conversation-list__items \{[^}]*background:\s*var\(--surface\)/);
    expect(globalStyles).toMatch(/\.conversation-list__item \{[^}]*background:\s*var\(--surface\)/);
    expect(globalStyles).toMatch(/:root \{[\s\S]*--surface:\s*#FFFFFF/);
    expect(globalStyles).toMatch(/:root\[data-theme="dark"\][\s\S]*--surface:\s*#[0-9A-Fa-f]{6}/);
    expect(globalStyles).not.toMatch(/\.conversation-list__items \{[^}]*background-image/);
  });

  it("moves Alerts into root-only settings", () => {
    expect(manifest).toContain('href: "/alertas"');
    expect(manifest).toContain('rootOnly: true');
    // O destino "Alertas" mora na sidebar das configurações (o hub não tem mais
    // settingsDestinations): a linha única pina label + gate root-only e a
    // seguinte pina o remapeamento para a sub-rota /configuracoes/alertas.
    expect(settingsSidebar).toContain('"/alertas": { label: "Alertas", Icon: BellRinging, rootWorkspaceOnly: true');
    expect(settingsSidebar).toContain('"/alertas": "/configuracoes/alertas"');
    expect(alerts).toContain("canAccessRootWorkspace(session)");
  });

  it("removes the development reset button", () => {
    expect(rootWorkspaces).not.toContain("MODO DEV");
    expect(rootWorkspaces).not.toContain("resetContactsAndMessages");
    expect(rootWorkspaces).not.toContain("devResetId");
  });
});
