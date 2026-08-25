import { describe, expect, it, vi } from "vitest";
import { capabilityForAiTool, filterAiToolsByCapabilities } from "../src/capabilities/ai-tools.js";
import { capabilityForPanelRoute } from "../src/capabilities/gate.js";
import { createSchedulingToolExecutor } from "../src/modules/ai-router/tool-executor.js";

describe("capability route manifest", () => {
  it.each([
    ["/dashboard", "GET", "dashboard_v1"],
    ["/dashboard/widgets/catalog", "GET", "dashboard_v1"],
    ["/scheduling/leads", "GET", "leads_v1"],
    ["/qualification/flows", "GET", "leads_v1"],
    ["/organization/pipeline", "GET", "pipeline_v1"],
    ["/organization/bulk/apply", "POST", "pipeline_v1"],
    ["/scheduling/appointments", "GET", "appointments_v1"],
    ["/scheduling/availability", "GET", "appointments_v1"],
    ["/connection", "GET", "workspace_admin_v1"],
    ["/agent/versions", "GET", "workspace_admin_v1"],
    ["/workspaces/current/api-keys", "GET", "workspace_admin_v1"],
    ["/workspaces/current/timezone", "PATCH", "workspace_admin_v1"]
  ] as const)("maps %s to %s", (path, method, expected) => {
    expect(capabilityForPanelRoute(path, method)).toBe(expected);
  });

  it.each([
    ["/conversations", "GET"],
    ["/me", "GET"],
    ["/workspaces/current/invitations", "GET"],
    ["/root/workspaces", "GET"]
  ] as const)("keeps core route %s outside capabilities", (path, method) => {
    expect(capabilityForPanelRoute(path, method)).toBeUndefined();
  });
});

describe("AI tool capability filtering", () => {
  it("classifies lead and appointment tools without gating conversation-only tools", () => {
    expect(capabilityForAiTool("registrar_lead")).toBe("leads_v1");
    expect(capabilityForAiTool("agendar_reuniao")).toBe("appointments_v1");
    expect(capabilityForAiTool("pesquisar_contexto")).toBeUndefined();
  });

  it("removes stale configured tools for disabled capabilities", async () => {
    const enabled = vi.fn(async (key: string) => key === "leads_v1");
    const tools = await filterAiToolsByCapabilities(
      ["pesquisar_contexto", "registrar_lead", "consultar_agendas", "agendar_reuniao"],
      enabled as never
    );
    expect(tools).toEqual(["pesquisar_contexto", "registrar_lead"]);
    expect(enabled).toHaveBeenCalledTimes(2);
  });

  it("revalidates immediately before a stale provider tool call executes", async () => {
    const capabilityEnabled = vi.fn(async () => false);
    const executor = createSchedulingToolExecutor("tenant-1", "5511999999999", undefined, {
      conversationId: "conversation-1",
      inboundExternalId: "message-1",
      aiTurnId: "turn-1",
      enabledToolNames: ["registrar_lead"],
      journal: async (_input, execute) => execute(),
      capabilityEnabled
    });
    const result = JSON.parse(await executor("registrar_lead", JSON.stringify({ nome: "Lia" })));
    expect(result.erro).toContain("Funcionalidade indisponível");
    expect(capabilityEnabled).toHaveBeenCalledWith("registrar_lead");
  });
});
