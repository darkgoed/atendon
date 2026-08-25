import { createClient } from "redis";
import { config } from "../../config.js";
import { logger } from "../../logger.js";

const PRESENCE_TTL_MS = 45_000;
const PRESENCE_KEY_PREFIX = "atendon:panel-presence:v1";

type RedisClient = ReturnType<typeof createClient>;

export function isPresenceScoreOnline(score: number | null, now = Date.now()): boolean {
  return score !== null && Number.isFinite(score) && score > now;
}

export class PanelPresenceStore {
  private client: RedisClient | null = null;
  private connecting: Promise<RedisClient | null> | null = null;

  constructor(private readonly redisUrl = config.REDIS_URL) {}

  async touch(tenantId: string, userId: string, now = Date.now()): Promise<boolean> {
    const client = await this.connection();
    if (!client) return false;
    try {
      const key = `${PRESENCE_KEY_PREFIX}:${tenantId}`;
      await Promise.all([
        client.zAdd(key, { score: now + PRESENCE_TTL_MS, value: userId }),
        client.zRemRangeByScore(key, 0, now)
      ]);
      return true;
    } catch (error) {
      logger.warn({ err: error }, "Panel presence heartbeat failed");
      return false;
    }
  }

  async onlineUsers(tenantId: string, userIds: readonly string[], now = Date.now()): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    const client = await this.connection();
    if (!client) return new Set();
    try {
      const key = `${PRESENCE_KEY_PREFIX}:${tenantId}`;
      const scores = await Promise.all(userIds.map((userId) => client.zScore(key, userId)));
      return new Set(userIds.filter((userId, index) => isPresenceScoreOnline(scores[index] ?? null, now)));
    } catch (error) {
      logger.warn({ err: error }, "Panel presence lookup failed");
      return new Set();
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connecting = null;
    if (!client?.isOpen) return;
    try { await client.quit(); } catch { client.destroy(); }
  }

  private async connection(): Promise<RedisClient | null> {
    if (this.client?.isReady) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = createClient({
        url: this.redisUrl,
        socket: { connectTimeout: 800, reconnectStrategy: false }
      });
      client.on("error", () => undefined);
      try {
        await client.connect();
        this.client = client;
        return client;
      } catch {
        if (client.isOpen) client.destroy();
        return null;
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }
}

export const panelPresence = new PanelPresenceStore();
