// R9/R10 — classificação de fonte (IA vs robô vs humano), agrupamento
// narrativo, tempo relativo e paginação keyset da fonte de eventos do lead.

import { describe, expect, it } from "vitest";
import {
  appendEventPage,
  groupLeadEvents,
  leadEventActor,
  leadEventDetail,
  leadEventGroup,
  leadEventSource,
  leadEventTitle,
  leadTimelineUrl,
  leadActivitiesUrl,
  LEAD_EVENT_GROUP_LABELS,
  relativeEventTime
} from "@/lib/lead-history";

describe("lead event source", () => {
  it("honors the declared source before type prefix and actor", () => {
    expect(leadEventSource({ type: "lead.updated", at: "2026-09-18T10:00:00Z", actor: "ana@x.com", detail: { source: "ai" } })).toBe("ai");
    expect(leadEventSource({ type: "lead.updated", at: "2026-09-18T10:00:00Z", actor: "sistema", detail: { source: "human" } })).toBe("human");
  });

  it("separates AI events from robot steps and humans by type prefix", () => {
    expect(leadEventSource({ type: "ai.qualification", at: "2026-09-18T10:00:00Z" })).toBe("ai");
    expect(leadEventSource({ type: "flow.step", at: "2026-09-18T10:00:00Z", actor: "Robô de boas-vindas" })).toBe("robot");
    expect(leadEventSource({ type: "robot.message", at: "2026-09-18T10:00:00Z" })).toBe("robot");
  });

  it("classifies by actor when the type is neutral, treating missing actor as robot", () => {
    expect(leadEventSource({ type: "lead.updated", at: "2026-09-18T10:00:00Z", actor: "ana@x.com" })).toBe("human");
    expect(leadEventSource({ type: "lead.updated", at: "2026-09-18T10:00:00Z", actor: "IA" })).toBe("ai");
    expect(leadEventSource({ type: "lead.updated", at: "2026-09-18T10:00:00Z", actor: "Sistema" })).toBe("robot");
    expect(leadEventSource({ type: "lead.updated", at: "2026-09-18T10:00:00Z" })).toBe("robot");
  });
});

describe("lead event groups", () => {
  it("maps every event type into the narrative buckets", () => {
    expect(leadEventGroup("lead.created")).toBe("origin");
    expect(leadEventGroup("lead.imported")).toBe("origin");
    expect(leadEventGroup("qualification.updated")).toBe("qualification");
    expect(leadEventGroup("tag.added")).toBe("tags");
    expect(leadEventGroup("stage.changed")).toBe("pipeline");
    expect(leadEventGroup("responsible.changed")).toBe("responsible");
    expect(leadEventGroup("transfer.requested")).toBe("transfer");
    expect(leadEventGroup("appointment.created")).toBe("appointment");
    expect(leadEventGroup("note.added")).toBe("note");
    expect(leadEventGroup("lead.closed.won")).toBe("closing");
    expect(leadEventGroup("lead.closed.lost")).toBe("closing");
    expect(leadEventGroup("qualquer.coisa")).toBe("other");
  });

  it("orders groups as entrou → aconteceu → saiu and sorts events inside each", () => {
    const sections = groupLeadEvents([
      { type: "lead.closed.won", at: "2026-09-18T09:00:00Z" },
      { type: "lead.created", at: "2026-09-01T09:00:00Z" },
      { type: "lead.created", at: "2026-09-01T08:00:00Z" },
      { type: "tag.added", at: "2026-09-05T09:00:00Z" }
    ]);
    expect(sections.map((section) => section.group)).toEqual(["origin", "tags", "closing"]);
    expect(sections[0].events.map((event) => event.at)).toEqual(["2026-09-01T09:00:00Z", "2026-09-01T08:00:00Z"]);
    expect(LEAD_EVENT_GROUP_LABELS.closing).toBe("Encerramento, venda e perda");
  });
});

describe("lead event presentation helpers", () => {
  it("uses the pt-BR dictionary with a humanize fallback", () => {
    expect(leadEventTitle("lead.created")).toBe("Lead criado");
    expect(leadEventTitle("lead.closed.won")).toBe("Venda concluída");
    expect(leadEventTitle("campanha_x")).toBe("Campanha X");
    expect(leadEventTitle("")).toBe("Evento");
  });

  it("extracts a readable detail from strings and objects", () => {
    expect(leadEventDetail("Atribuída a Ana")).toBe("Atribuída a Ana");
    expect(leadEventDetail({ motivo: "Cliente pediu troca" })).toBe("Cliente pediu troca");
    expect(leadEventDetail({ de: "novo", para: "qualificado" })).toBe("de: novo · para: qualificado");
    expect(leadEventDetail(null)).toBe("");
  });

  it("normalizes the actor label", () => {
    expect(leadEventActor("ana@x.com")).toBe("ana@x.com");
    expect(leadEventActor("  ")).toBe("Sistema");
    expect(leadEventActor(undefined)).toBe("Sistema");
  });
});

describe("relative event time", () => {
  const now = Date.parse("2026-09-18T12:00:00Z");

  it("formats pt-BR relative labels without Intl.RelativeTimeFormat", () => {
    expect(relativeEventTime("2026-09-18T12:00:30Z", now)).toBe("agora");
    expect(relativeEventTime("2026-09-18T11:55:00Z", now)).toBe("há 5 min");
    expect(relativeEventTime("2026-09-18T10:30:00Z", now)).toBe("há 1 h");
    expect(relativeEventTime("2026-09-17T12:00:00Z", now)).toBe("ontem");
    expect(relativeEventTime("2026-09-15T12:00:00Z", now)).toBe("há 3 dias");
    expect(relativeEventTime("2026-06-20T12:00:00Z", now)).toBe("há 3 meses");
    expect(relativeEventTime("2024-06-20T12:00:00Z", now)).toBe("há 2 anos");
  });

  it("is tolerant to future timestamps and invalid dates", () => {
    expect(relativeEventTime("2026-09-18T12:05:00Z", now)).toBe("agora");
    expect(relativeEventTime("não-é-data", now)).toBe("");
  });
});

describe("keyset pagination", () => {
  it("appends the older page deduplicating against loaded events", () => {
    const first = [{ type: "lead.created", at: "2026-09-02T10:00:00Z", actor: "sistema" }];
    const older = [
      { type: "lead.created", at: "2026-09-02T10:00:00Z", actor: "sistema" },
      { type: "tag.added", at: "2026-09-01T10:00:00Z", actor: "ana@x.com", detail: { source: "human" } }
    ];
    expect(appendEventPage(first, older)).toHaveLength(2);
    expect(appendEventPage([], older)).toHaveLength(2);
  });

  it("builds contract URLs with cursor and page size", () => {
    expect(leadTimelineUrl("lead-1")).toBe("/scheduling/leads/lead-1/timeline?limit=20");
    expect(leadTimelineUrl("lead-1", "cur==")).toBe("/scheduling/leads/lead-1/timeline?cursor=cur%3D%3D&limit=20");
    expect(leadActivitiesUrl("lead-1", "c1")).toBe("/scheduling/leads/lead-1/activities?cursor=c1&limit=20");
  });
});
