import {
  catchupSseEvent,
  internalSignalKey,
  opaqueRealtimeEventId,
  publicRealtimeSignal,
  serializeSseEvent,
  type InternalRealtimeSignal
} from "./signals.js";
import { incrementRealtimeMetric } from "../operations/observability-metrics.js";
import type { PermissionKey } from "../../auth/rbac.js";

export interface RealtimeConnection {
  tenantId: string;
  userId: string;
  caseScope: "workspace" | "mine";
  permissions: ReadonlySet<PermissionKey>;
  write(chunk: string): boolean;
  close(): void;
}

export interface RealtimeAudience {
  assignedUserId?: string | null;
  visibleUserIds?: ReadonlySet<string>;
}

export interface RealtimeHubOptions {
  maxConnections?: number;
  maxConnectionsPerTenant?: number;
  maxConnectionsPerUser?: number;
  heartbeatMs?: number;
  duplicateWindowMs?: number;
}

export class RealtimeHub {
  private readonly connections = new Set<RealtimeConnection>();
  private readonly recentSignals = new Map<string, number>();
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly options: Required<RealtimeHubOptions>;

  constructor(options: RealtimeHubOptions = {}) {
    this.options = {
      maxConnections: options.maxConnections ?? 500,
      maxConnectionsPerTenant: options.maxConnectionsPerTenant ?? 50,
      maxConnectionsPerUser: options.maxConnectionsPerUser ?? 5,
      heartbeatMs: options.heartbeatMs ?? 15_000,
      duplicateWindowMs: options.duplicateWindowMs ?? 60_000
    };
  }

  add(connection: RealtimeConnection, lastEventId?: string): (() => void) | null {
    const tenantConnections = [...this.connections]
      .filter((candidate) => candidate.tenantId === connection.tenantId).length;
    const userConnections = [...this.connections]
      .filter((candidate) => (
        candidate.tenantId === connection.tenantId
        && candidate.userId === connection.userId
      )).length;
    if (
      this.connections.size >= this.options.maxConnections
      || tenantConnections >= this.options.maxConnectionsPerTenant
      || userConnections >= this.options.maxConnectionsPerUser
    ) {
      incrementRealtimeMetric("sse", "rejected");
      return null;
    }
    this.connections.add(connection);
    if (!connection.write("retry: 3000\n\n") || !connection.write(catchupSseEvent(lastEventId))) {
      this.connections.delete(connection);
      connection.close();
      incrementRealtimeMetric("sse", "rejected");
      return null;
    }
    incrementRealtimeMetric("sse", "accepted");
    if (lastEventId) incrementRealtimeMetric("sse", "catchup");
    this.ensureHeartbeat();
    return () => this.remove(connection);
  }

  broadcast(signal: InternalRealtimeSignal, audience: RealtimeAudience = {}): boolean {
    const now = Date.now();
    const key = internalSignalKey(signal);
    this.pruneRecent(now);
    if ((this.recentSignals.get(key) ?? 0) > now - this.options.duplicateWindowMs) return false;
    this.recentSignals.set(key, now);

    const frame = serializeSseEvent({
      event: "change",
      id: opaqueRealtimeEventId(key),
      data: publicRealtimeSignal(signal)
    });
    for (const connection of [...this.connections]) {
      if (connection.tenantId !== signal.tenantId) continue;
      if (!this.hasSignalPermission(connection, signal)) continue;
      if (!this.isVisible(connection, signal, audience)) continue;
      if (!connection.write(frame)) this.remove(connection);
    }
    return true;
  }

  closeAll(): void {
    for (const connection of [...this.connections]) this.remove(connection);
    this.recentSignals.clear();
  }

  get size(): number {
    return this.connections.size;
  }

  private remove(connection: RealtimeConnection): void {
    if (!this.connections.delete(connection)) return;
    incrementRealtimeMetric("sse", "closed");
    connection.close();
    if (this.connections.size === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private isVisible(
    connection: RealtimeConnection,
    signal: InternalRealtimeSignal,
    audience: RealtimeAudience
  ): boolean {
    if (connection.caseScope === "workspace") return true;
    if (signal.type === "case.assignment.changed" || signal.type === "appointment.changed") {
      return signal.previousUserId === connection.userId || signal.assignedUserId === connection.userId;
    }
    if (signal.type === "conversation.messages.changed" || signal.type === "conversation.ai.progress") {
      return audience.assignedUserId === connection.userId;
    }
    return audience.visibleUserIds?.has(connection.userId) === true;
  }

  private hasSignalPermission(
    connection: RealtimeConnection,
    signal: InternalRealtimeSignal
  ): boolean {
    if (signal.type === "alerts.changed") {
      return connection.permissions.has("dashboard.read");
    }
    if (signal.type === "conversation.messages.changed" || signal.type === "conversation.ai.progress") {
      return connection.permissions.has("conversations.read");
    }
    if (signal.type === "appointment.changed") {
      return connection.permissions.has("appointments.read");
    }
    if (signal.conversationId && !connection.permissions.has("conversations.read")) return false;
    if (signal.leadId && !connection.permissions.has("leads.read")) return false;
    return Boolean(signal.conversationId || signal.leadId);
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const connection of [...this.connections]) {
        if (!connection.write(": heartbeat\n\n")) this.remove(connection);
      }
    }, this.options.heartbeatMs);
    this.heartbeat.unref();
  }

  private pruneRecent(now: number): void {
    const minimum = now - this.options.duplicateWindowMs;
    for (const [key, seenAt] of this.recentSignals) {
      if (seenAt <= minimum) this.recentSignals.delete(key);
    }
  }
}
