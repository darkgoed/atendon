import type { Pool } from "pg";
import { createClient } from "redis";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { logger } from "../../logger.js";
import { isFeatureFlagEnabled } from "../operations/feature-flags.js";
import {
  AI_TURN_PROGRESS_TTL_MS,
  aiTurnProgressSchema,
  type AiTurnPhase,
  type AiTurnProgress
} from "./ai-turn-contract.js";
import { REALTIME_REDIS_CHANNEL, type InternalRealtimeSignal } from "./signals.js";

const AI_TURN_KEY_PREFIX = "atendon:conversation-ai-turn:v1";
const REDIS_RETRY_COOLDOWN_MS = 5_000;

type RedisClient = ReturnType<typeof createClient>;

const SET_IF_CURRENT_SCRIPT = `
local current = redis.call('get', KEYS[1])
if current then
  local existing = cjson.decode(current)
  local incoming = cjson.decode(ARGV[1])
  if existing.startedAt > incoming.startedAt then return 0 end
  if existing.startedAt == incoming.startedAt and existing.attempt > incoming.attempt then return 0 end
  if existing.startedAt == incoming.startedAt and existing.attempt == incoming.attempt and existing.revision > incoming.revision then return 0 end
end
redis.call('psetex', KEYS[1], ARGV[2], ARGV[1])
return 1
`;

const CLEAR_IF_TURN_SCRIPT = `
local current = redis.call('get', KEYS[1])
if not current then return 0 end
local existing = cjson.decode(current)
if existing.turnId ~= ARGV[1] then return 0 end
return redis.call('del', KEYS[1])
`;

export interface AiTurnProgressSession {
  readonly turnId: string;
  readonly attempt: number;
  readonly startedAt: string;
  publish(input: {
    phase: AiTurnPhase;
    label?: string;
    preview?: string;
    previewTruncated?: boolean;
  }): Promise<AiTurnProgress>;
  clear(label?: string): Promise<void>;
}

export interface AiTurnProgressPublisher {
  start(input: {
    tenantId: string;
    conversationId: string;
    turnId: string;
    attempt: number;
    phase?: AiTurnPhase;
    label?: string;
  }): Promise<AiTurnProgressSession | null>;
}

class RedisAiTurnProgressSession implements AiTurnProgressSession {
  readonly startedAt: string;
  private revision = -1;
  private cleared = false;

  constructor(
    private readonly store: AiTurnProgressStore,
    private readonly tenantId: string,
    private readonly conversationId: string,
    readonly turnId: string,
    readonly attempt: number,
    startedAt = new Date().toISOString()
  ) {
    this.startedAt = startedAt;
  }

  async publish(input: {
    phase: AiTurnPhase;
    label?: string;
    preview?: string;
    previewTruncated?: boolean;
  }): Promise<AiTurnProgress> {
    this.cleared = input.phase === "cleared";
    this.revision += 1;
    const now = new Date();
    const progress = aiTurnProgressSchema.parse({
      type: "conversation.ai.progress",
      conversationId: this.conversationId,
      turnId: this.turnId,
      attempt: this.attempt,
      revision: this.revision,
      phase: input.phase,
      ...(input.label ? { label: input.label } : {}),
      ...(input.preview !== undefined ? { preview: input.preview } : {}),
      ...(input.previewTruncated !== undefined
        ? { previewTruncated: input.previewTruncated }
        : {}),
      startedAt: this.startedAt,
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + AI_TURN_PROGRESS_TTL_MS).toISOString()
    });
    await this.store.write(this.tenantId, progress);
    return progress;
  }

  async clear(label?: string): Promise<void> {
    if (this.cleared) return;
    this.cleared = true;
    this.revision += 1;
    await this.store.clear(this.tenantId, {
      type: "conversation.ai.progress",
      conversationId: this.conversationId,
      turnId: this.turnId,
      attempt: this.attempt,
      revision: this.revision,
      phase: "cleared",
      ...(label ? { label } : {}),
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + AI_TURN_PROGRESS_TTL_MS).toISOString()
    });
  }
}

export class AiTurnProgressStore implements AiTurnProgressPublisher {
  private client: RedisClient | null = null;
  private connecting: Promise<RedisClient | null> | null = null;
  private unavailableUntil = 0;

  constructor(
    private readonly pool: Pool,
    private readonly redisUrl = config.REDIS_URL
  ) {}

  async start(input: {
    tenantId: string;
    conversationId: string;
    turnId: string;
    attempt: number;
    phase?: AiTurnPhase;
    label?: string;
  }): Promise<AiTurnProgressSession | null> {
    let enabled = false;
    try {
      enabled = await isFeatureFlagEnabled(this.pool, input.tenantId, "ai_turn_visibility_v1");
    } catch (error) {
      logger.warn({
        err: error,
        conversationId: input.conversationId,
        turnId: input.turnId,
        phase: input.phase ?? "reading"
      }, "AI turn visibility flag lookup failed");
      return null;
    }
    if (!enabled) return null;
    // If Redis is unavailable, keep the feature fully observational: the
    // processor must not apply preview-only delays when nobody can see them.
    if (!await this.connection()) return null;
    const session = new RedisAiTurnProgressSession(
      this,
      input.tenantId,
      input.conversationId,
      input.turnId,
      input.attempt
    );
    await session.publish({
      phase: input.phase ?? "reading",
      label: input.label ?? "Lendo a conversa…"
    });
    return session;
  }

  async get(tenantId: string, conversationId: string): Promise<AiTurnProgress | null> {
    try {
      if (!await isFeatureFlagEnabled(this.pool, tenantId, "ai_turn_visibility_v1")) return null;
      const client = await this.connection();
      if (!client) return null;
      const raw = await client.get(this.key(tenantId, conversationId));
      if (!raw) return null;
      const parsed = aiTurnProgressSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || new Date(parsed.data.expiresAt).getTime() <= Date.now()) return null;
      return parsed.data;
    } catch (error) {
      logger.warn({ err: error, conversationId }, "AI turn progress recovery failed");
      return null;
    }
  }

  async write(tenantId: string, progress: AiTurnProgress): Promise<void> {
    try {
      const client = await this.connection();
      if (!client) return;
      const stored = await client.eval(SET_IF_CURRENT_SCRIPT, {
        keys: [this.key(tenantId, progress.conversationId)],
        arguments: [JSON.stringify(progress), String(AI_TURN_PROGRESS_TTL_MS)]
      });
      if (stored !== 1) return;
      await client.publish(REALTIME_REDIS_CHANNEL, JSON.stringify(this.internalSignal(tenantId, progress)));
    } catch (error) {
      this.markUnavailable();
      logger.warn({
        err: error,
        conversationId: progress.conversationId,
        turnId: progress.turnId,
        phase: progress.phase
      }, "AI turn progress publication failed");
    }
  }

  async clear(tenantId: string, progress: AiTurnProgress): Promise<void> {
    try {
      const client = await this.connection();
      if (!client) return;
      const cleared = await client.eval(CLEAR_IF_TURN_SCRIPT, {
        keys: [this.key(tenantId, progress.conversationId)],
        arguments: [progress.turnId]
      });
      if (cleared !== 1) return;
      await client.publish(REALTIME_REDIS_CHANNEL, JSON.stringify(this.internalSignal(tenantId, progress)));
    } catch (error) {
      this.markUnavailable();
      logger.warn({
        err: error,
        conversationId: progress.conversationId,
        turnId: progress.turnId,
        phase: "cleared"
      }, "AI turn progress clear failed");
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connecting = null;
    if (!client?.isOpen) return;
    try { await client.quit(); } catch { client.destroy(); }
  }

  private internalSignal(tenantId: string, progress: AiTurnProgress): InternalRealtimeSignal {
    return { v: 1, tenantId, ...progress };
  }

  private key(tenantId: string, conversationId: string): string {
    return `${AI_TURN_KEY_PREFIX}:${tenantId}:${conversationId}`;
  }

  private markUnavailable(): void {
    this.unavailableUntil = Date.now() + REDIS_RETRY_COOLDOWN_MS;
    if (this.client?.isOpen) this.client.destroy();
    this.client = null;
    this.connecting = null;
  }

  private async connection(): Promise<RedisClient | null> {
    if (this.client?.isReady) return this.client;
    if (Date.now() < this.unavailableUntil) return null;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = createClient({
        url: this.redisUrl,
        socket: { connectTimeout: 200, reconnectStrategy: false }
      });
      client.on("error", () => undefined);
      try {
        await client.connect();
        this.client = client;
        return client;
      } catch {
        if (client.isOpen) client.destroy();
        this.unavailableUntil = Date.now() + REDIS_RETRY_COOLDOWN_MS;
        return null;
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }
}

export const aiTurnProgressStore = new AiTurnProgressStore(db);
