import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

let agendaActions = "";
let agendaDetail = "";
let alerts = "";
let configurations = "";
let conversations = "";
let globalStyles = "";
let rootWorkspaces = "";
let manifest = "";

beforeAll(async () => {
  [agendaActions, agendaDetail, alerts, configurations, conversations, globalStyles, rootWorkspaces, manifest] = await Promise.all([
    readFile(new URL("../app/agenda/use-agenda-actions.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/agenda/agenda-detail-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/alertas/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/configuracoes/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/conversas/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
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
    // A lista usa --surface (branco no tema claro) em vez de um override #fff:
    // o handoff B2B removeu a textura pontilhada, então não há mais background-image a anular.
    expect(globalStyles).toContain(".conversation-list__items { padding:0!important; background:var(--surface); }");
    expect(globalStyles).toMatch(/\.conversation-list__item \{[^}]*background:var\(--surface\)/);
    expect(globalStyles).toMatch(/:root\[data-theme="light"\][\s\S]*--surface:#FFFFFF/);
    expect(globalStyles).not.toMatch(/\.conversation-list__items \{[^}]*background-image/);
  });

  it("moves Alerts into root-only settings", () => {
    expect(manifest).toContain('href: "/alertas"');
    expect(manifest).toContain('rootOnly: true');
    expect(configurations).toContain('{ href: "/alertas", label: "Alertas"');
    expect(configurations).toContain("rootWorkspaceOnly: true");
    expect(alerts).toContain("canAccessRootWorkspace(session)");
  });

  it("removes the development reset button", () => {
    expect(rootWorkspaces).not.toContain("MODO DEV");
    expect(rootWorkspaces).not.toContain("resetContactsAndMessages");
    expect(rootWorkspaces).not.toContain("devResetId");
  });
});
