import { describe, expect, it, vi } from "vitest";
import { RealtimeHub, type RealtimeConnection } from "../src/modules/realtime/hub.js";
import {
  catchupSseEvent,
  parseInternalRealtimeSignal,
  publicRealtimeSignal
} from "../src/modules/realtime/signals.js";
import {
  inMemoryOperationalMetrics,
  resetOperationalMetricsForTests
} from "../src/modules/operations/observability-metrics.js";
import type { PermissionKey } from "../src/auth/rbac.js";
import { sameRealtimeAuthorization } from "../src/modules/realtime/routes.js";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
const conversationA = "33333333-3333-4333-8333-333333333333";
const entity = "44444444-4444-4444-8444-444444444444";

function connection(
  tenantId: string,
  options: {
    userId?: string;
    caseScope?: "workspace" | "mine";
    permissions?: PermissionKey[];
  } = {}
) {
  const chunks: string[] = [];
  const close = vi.fn();
  const value: RealtimeConnection = {
    tenantId,
    userId: options.userId ?? `${tenantId}:user`,
    caseScope: options.caseScope ?? "workspace",
    permissions: new Set(options.permissions ?? [
      "dashboard.read",
      "conversations.read",
      "leads.read"
    ]),
    write: (chunk) => {
      chunks.push(chunk);
      return true;
    },
    close
  };
  return { value, chunks, close };
}

describe("RealtimeHub", () => {
  it("forces an SSE reconnect when tenant authorization changes", () => {
    const original = {
      tenantId: tenantA,
      userId: "user-a",
      actorScope: "workspace" as const,
      role: "OPERADOR",
      roleId: "role-a",
      permissions: ["conversations.read", "leads.read"] as PermissionKey[]
    };
    expect(sameRealtimeAuthorization(original, {
      ...original,
      permissions: [...original.permissions].reverse()
    })).toBe(true);
    expect(sameRealtimeAuthorization(original, {
      ...original,
      tenantId: tenantB
    })).toBe(false);
    expect(sameRealtimeAuthorization(original, {
      ...original,
      roleId: "role-b",
      permissions: ["conversations.read"]
    })).toBe(false);
  });

  it("emits an opaque catch-up event on reconnect without echoing Last-Event-ID", () => {
    const frame = catchupSseEvent("provider-or-database-sensitive-value");
    expect(frame).toContain("event: catchup");
    expect(frame).toContain('"reconnect":true');
    expect(frame).not.toContain("provider-or-database-sensitive-value");
  });

  it("counts accepted, catch-up and closed SSE connections with fixed labels", () => {
    resetOperationalMetricsForTests();
    const hub = new RealtimeHub({ heartbeatMs: 60_000 });
    const client = connection(tenantA);
    const remove = hub.add(client.value, "opaque-last-event");
    expect(remove).not.toBeNull();
    let snapshot = inMemoryOperationalMetrics({
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      options: { max: 10 }
    } as never);
    expect(snapshot.realtime.active_sse_connections).toBe(1);
    expect(snapshot.realtime.counters).toEqual(expect.arrayContaining([
      { labels: { component: "sse", event: "accepted" }, value: 1 },
      { labels: { component: "sse", event: "catchup" }, value: 1 }
    ]));
    remove?.();
    snapshot = inMemoryOperationalMetrics({
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      options: { max: 10 }
    } as never);
    expect(snapshot.realtime.active_sse_connections).toBe(0);
    expect(snapshot.realtime.counters).toContainEqual({
      labels: { component: "sse", event: "closed" },
      value: 1
    });
  });

  it("isolates tenants and deduplicates the same durable database signal", () => {
    const hub = new RealtimeHub({ heartbeatMs: 60_000 });
    const left = connection(tenantA);
    const right = connection(tenantB);
    expect(hub.add(left.value)).not.toBeNull();
    expect(hub.add(right.value)).not.toBeNull();
    left.chunks.length = 0;
    right.chunks.length = 0;

    const signal = {
      v: 1 as const,
      type: "conversation.messages.changed" as const,
      tenantId: tenantA,
      conversationId: conversationA,
      entityId: entity
    };
    expect(hub.broadcast(signal)).toBe(true);
    expect(hub.broadcast(signal)).toBe(false);
    expect(left.chunks.join("")).toContain(conversationA);
    expect(right.chunks).toEqual([]);
    hub.closeAll();
  });

  it("deduplicates independently when two tenants use the same entity id", () => {
    const hub = new RealtimeHub({ heartbeatMs: 60_000 });
    const left = connection(tenantA);
    const right = connection(tenantB);
    hub.add(left.value);
    hub.add(right.value);
    left.chunks.length = 0;
    right.chunks.length = 0;

    const base = {
      v: 1 as const,
      type: "conversation.messages.changed" as const,
      conversationId: conversationA,
      entityId: entity
    };
    expect(hub.broadcast({ ...base, tenantId: tenantA })).toBe(true);
    expect(hub.broadcast({ ...base, tenantId: tenantB })).toBe(true);
    expect(left.chunks.join("")).toContain(conversationA);
    expect(right.chunks.join("")).toContain(conversationA);
    hub.closeAll();
  });

  it("applies per-user connection limits within each tenant", () => {
    const hub = new RealtimeHub({ heartbeatMs: 60_000, maxConnectionsPerUser: 1 });
    const sharedUserId = "55555555-5555-4555-8555-555555555555";
    const tenantAFirst = connection(tenantA, { userId: sharedUserId });
    const tenantASecond = connection(tenantA, { userId: sharedUserId });
    const tenantBFirst = connection(tenantB, { userId: sharedUserId });

    expect(hub.add(tenantAFirst.value)).not.toBeNull();
    expect(hub.add(tenantASecond.value)).toBeNull();
    expect(hub.add(tenantBFirst.value)).not.toBeNull();
    hub.closeAll();
  });

  it("does not deliver entity identifiers without the matching effective permission", () => {
    const hub = new RealtimeHub({ heartbeatMs: 60_000 });
    const denied = connection(tenantA, { permissions: ["dashboard.read"] });
    hub.add(denied.value);
    denied.chunks.length = 0;
    hub.broadcast({
      v: 1,
      type: "conversation.messages.changed",
      tenantId: tenantA,
      conversationId: conversationA,
      entityId: entity
    });
    expect(denied.chunks).toEqual([]);
    hub.closeAll();
  });

  it("strips tenant and entity identifiers from public frames", () => {
    const internal = parseInternalRealtimeSignal({
      v: 1,
      type: "alerts.changed",
      tenantId: tenantA,
      entityId: entity
    });
    expect(internal).not.toBeNull();
    expect(publicRealtimeSignal(internal!)).toEqual({ type: "alerts.changed" });
  });

  it("delivers case events only to managers and the responsible operator", () => {
    const hub = new RealtimeHub({ heartbeatMs: 60_000 });
    const manager = connection(tenantA);
    const beto = connection(tenantA, {
      userId: "55555555-5555-4555-8555-555555555555",
      caseScope: "mine"
    });
    const julia = connection(tenantA, {
      userId: "66666666-6666-4666-8666-666666666666",
      caseScope: "mine"
    });
    hub.add(manager.value);
    hub.add(beto.value);
    hub.add(julia.value);
    manager.chunks.length = 0;
    beto.chunks.length = 0;
    julia.chunks.length = 0;

    hub.broadcast({
      v: 1,
      type: "conversation.messages.changed",
      tenantId: tenantA,
      conversationId: conversationA,
      entityId: entity
    }, { assignedUserId: beto.value.userId });

    expect(manager.chunks.join("")).toContain(conversationA);
    expect(beto.chunks.join("")).toContain(conversationA);
    expect(julia.chunks).toEqual([]);
    hub.closeAll();
  });

  it("scopes AI progress like conversation messages and strips tenant data", () => {
    const hub = new RealtimeHub({ heartbeatMs: 60_000 });
    const manager = connection(tenantA);
    const assigned = connection(tenantA, {
      userId: "55555555-5555-4555-8555-555555555555",
      caseScope: "mine",
      permissions: ["conversations.read"]
    });
    const unrelated = connection(tenantA, {
      userId: "66666666-6666-4666-8666-666666666666",
      caseScope: "mine",
      permissions: ["conversations.read"]
    });
    hub.add(manager.value);
    hub.add(assigned.value);
    hub.add(unrelated.value);
    manager.chunks.length = 0;
    assigned.chunks.length = 0;
    unrelated.chunks.length = 0;
    const signal = parseInternalRealtimeSignal({
      v: 1,
      type: "conversation.ai.progress",
      tenantId: tenantA,
      conversationId: conversationA,
      turnId: "turn-1",
      attempt: 1,
      revision: 3,
      phase: "preview",
      label: "Prévia · ainda não enviada",
      preview: "Olá",
      startedAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-10T10:00:01.000Z",
      expiresAt: "2026-08-10T10:30:01.000Z"
    });
    expect(signal).not.toBeNull();
    hub.broadcast(signal!, { assignedUserId: assigned.value.userId });
    expect(manager.chunks.join("")).toContain("conversation.ai.progress");
    expect(assigned.chunks.join("")).toContain("\"preview\":\"Olá\"");
    expect(unrelated.chunks).toEqual([]);
    expect(assigned.chunks.join("")).not.toContain(tenantA);
    expect(publicRealtimeSignal(signal!)).not.toHaveProperty("tenantId");
    hub.closeAll();
  });

  it("refreshes both sides of a transfer without exposing assignee IDs", () => {
    const hub = new RealtimeHub({ heartbeatMs: 60_000 });
    const previousUserId = "55555555-5555-4555-8555-555555555555";
    const assignedUserId = "66666666-6666-4666-8666-666666666666";
    const previous = connection(tenantA, { userId: previousUserId, caseScope: "mine" });
    const assigned = connection(tenantA, { userId: assignedUserId, caseScope: "mine" });
    const unrelated = connection(tenantA, {
      userId: "77777777-7777-4777-8777-777777777777",
      caseScope: "mine"
    });
    hub.add(previous.value);
    hub.add(assigned.value);
    hub.add(unrelated.value);
    previous.chunks.length = 0;
    assigned.chunks.length = 0;
    unrelated.chunks.length = 0;

    const signal = {
      v: 1 as const,
      type: "case.assignment.changed" as const,
      tenantId: tenantA,
      caseId: conversationA,
      conversationId: conversationA,
      entityId: entity,
      previousUserId,
      assignedUserId
    };
    hub.broadcast(signal);

    expect(previous.chunks.join("")).toContain(conversationA);
    expect(assigned.chunks.join("")).toContain(conversationA);
    expect(previous.chunks.join("")).not.toContain(previousUserId);
    expect(previous.chunks.join("")).not.toContain(assignedUserId);
    expect(unrelated.chunks).toEqual([]);
    expect(publicRealtimeSignal(signal)).toEqual({
      type: "case.assignment.changed",
      caseId: conversationA,
      conversationId: conversationA
    });
    hub.closeAll();
  });

  it("does not announce unassigned or recipient-less case data to operators", () => {
    const hub = new RealtimeHub({ heartbeatMs: 60_000 });
    const operator = connection(tenantA, {
      userId: "55555555-5555-4555-8555-555555555555",
      caseScope: "mine"
    });
    hub.add(operator.value);
    operator.chunks.length = 0;
    hub.broadcast({
      v: 1,
      type: "conversation.messages.changed",
      tenantId: tenantA,
      conversationId: conversationA,
      entityId: entity
    }, { assignedUserId: null });
    expect(operator.chunks).toEqual([]);
    hub.closeAll();
  });

  it("delivers alert refreshes only to operators with a receipt", () => {
    const hub = new RealtimeHub({ heartbeatMs: 60_000 });
    const recipient = connection(tenantA, {
      userId: "55555555-5555-4555-8555-555555555555",
      caseScope: "mine"
    });
    const unrelated = connection(tenantA, {
      userId: "66666666-6666-4666-8666-666666666666",
      caseScope: "mine"
    });
    hub.add(recipient.value);
    hub.add(unrelated.value);
    recipient.chunks.length = 0;
    unrelated.chunks.length = 0;
    hub.broadcast({
      v: 1,
      type: "alerts.changed",
      tenantId: tenantA,
      entityId: entity
    }, { visibleUserIds: new Set([recipient.value.userId]) });
    expect(recipient.chunks.join("")).toContain("alerts.changed");
    expect(unrelated.chunks).toEqual([]);
    hub.closeAll();
  });

  it("supports lead-only assignment refreshes for the old and new assignees", () => {
    const hub = new RealtimeHub({ heartbeatMs: 60_000 });
    const previousUserId = "55555555-5555-4555-8555-555555555555";
    const assignedUserId = "66666666-6666-4666-8666-666666666666";
    const leadId = "77777777-7777-4777-8777-777777777777";
    const previous = connection(tenantA, { userId: previousUserId, caseScope: "mine" });
    const assigned = connection(tenantA, { userId: assignedUserId, caseScope: "mine" });
    hub.add(previous.value);
    hub.add(assigned.value);
    previous.chunks.length = 0;
    assigned.chunks.length = 0;
    const signal = {
      v: 1 as const,
      type: "case.assignment.changed" as const,
      tenantId: tenantA,
      caseId: leadId,
      leadId,
      entityId: entity,
      previousUserId,
      assignedUserId
    };
    hub.broadcast(signal);
    expect(previous.chunks.join("")).toContain(leadId);
    expect(assigned.chunks.join("")).toContain(leadId);
    expect(previous.chunks.join("")).not.toContain(previousUserId);
    expect(previous.chunks.join("")).not.toContain(assignedUserId);
    expect(publicRealtimeSignal(signal)).toEqual({
      type: "case.assignment.changed",
      caseId: leadId,
      leadId
    });
    hub.closeAll();
  });

  it("delivers appointment refreshes only with agenda permission and matching case scope", () => {
    const hub = new RealtimeHub({ heartbeatMs: 60_000 });
    const assignedUserId = "55555555-5555-4555-8555-555555555555";
    const previousUserId = "66666666-6666-4666-8666-666666666666";
    const appointmentId = "77777777-7777-4777-8777-777777777777";
    const leadId = "88888888-8888-4888-8888-888888888888";
    const assigned = connection(tenantA, {
      userId: assignedUserId,
      caseScope: "mine",
      permissions: ["appointments.read"]
    });
    const previous = connection(tenantA, {
      userId: previousUserId,
      caseScope: "mine",
      permissions: ["appointments.read"]
    });
    const denied = connection(tenantA, {
      userId: assignedUserId,
      caseScope: "mine",
      permissions: ["leads.read"]
    });
    hub.add(assigned.value);
    hub.add(previous.value);
    hub.add(denied.value);
    assigned.chunks.length = 0;
    previous.chunks.length = 0;
    denied.chunks.length = 0;

    const signal = {
      v: 1 as const,
      type: "appointment.changed" as const,
      tenantId: tenantA,
      appointmentId,
      leadId,
      entityId: entity,
      previousUserId,
      assignedUserId
    };
    hub.broadcast(signal);

    expect(assigned.chunks.join("")).toContain(appointmentId);
    expect(previous.chunks.join("")).toContain(leadId);
    expect(denied.chunks).toEqual([]);
    expect(assigned.chunks.join("")).not.toContain(assignedUserId);
    expect(publicRealtimeSignal(signal)).toEqual({
      type: "appointment.changed",
      appointmentId,
      leadId
    });
    hub.closeAll();
  });
});
