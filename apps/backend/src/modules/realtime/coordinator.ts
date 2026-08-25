import pg from "pg";
import { createClient } from "redis";
import { RealtimeHub } from "./hub.js";
import {
  parseInternalRealtimeSignal,
  REALTIME_POSTGRES_CHANNEL,
  REALTIME_REDIS_CHANNEL,
  type InternalRealtimeSignal
} from "./signals.js";
import { incrementRealtimeMetric } from "../operations/observability-metrics.js";

type RedisClient = ReturnType<typeof createClient>;
type RealtimeLogger = {
  warn(value: unknown, message?: string): void;
  info(value: unknown, message?: string): void;
};
type SignalPublisher = {
  publish(channel: string, message: string): Promise<unknown>;
};

export async function publishRealtimeSignalBestEffort(
  publisher: SignalPublisher | null,
  signal: InternalRealtimeSignal,
  onError: (error: unknown) => void = () => undefined
): Promise<boolean> {
  if (!publisher) {
    incrementRealtimeMetric("redis_publish", "publish_error");
    return false;
  }
  try {
    await publisher.publish(REALTIME_REDIS_CHANNEL, JSON.stringify(signal));
    return true;
  } catch (error) {
    incrementRealtimeMetric("redis_publish", "publish_error");
    onError(error);
    return false;
  }
}

export class RealtimeCoordinator {
  readonly hub: RealtimeHub;
  private postgresClient: pg.PoolClient | null = null;
  private publisher: RedisClient | null = null;
  private subscriber: RedisClient | null = null;
  private starting: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly redisUrl: string,
    private readonly log: RealtimeLogger,
    hub = new RealtimeHub()
  ) {
    this.hub = hub;
  }

  async ensureStarted(): Promise<void> {
    if (this.stopped || (this.postgresClient && this.publisher?.isReady && this.subscriber?.isReady)) return;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.hub.closeAll();

    const postgresClient = this.postgresClient;
    this.postgresClient = null;
    if (postgresClient) {
      postgresClient.removeAllListeners("notification");
      postgresClient.removeAllListeners("error");
      try {
        await postgresClient.query(`UNLISTEN ${REALTIME_POSTGRES_CHANNEL}`);
      } catch {
        // The connection may already be gone.
      }
      postgresClient.release(true);
    }
    await Promise.allSettled([
      this.closeRedisClient(this.subscriber),
      this.closeRedisClient(this.publisher)
    ]);
    this.subscriber = null;
    this.publisher = null;
  }

  private async start(): Promise<void> {
    if (!this.postgresClient) {
      try {
        const client = await this.pool.connect();
        client.on("notification", (notification) => {
          if (notification.channel !== REALTIME_POSTGRES_CHANNEL) return;
          const signal = parseInternalRealtimeSignal(notification.payload);
          if (!signal) {
            incrementRealtimeMetric("postgres_listener", "parse_error");
            this.log.warn({ channel: notification.channel }, "Ignored invalid realtime database signal");
            return;
          }
          // Deliver to this instance's own SSE clients directly from the PostgreSQL
          // notification instead of waiting on the Redis round-trip. Redis is only
          // needed to fan the signal out to *other* API instances; requiring it for
          // local delivery meant a Redis outage silently broke realtime for everyone,
          // even though LISTEN/NOTIFY itself was healthy. hub.broadcast() dedupes by
          // signal key, so the redundant delivery when this signal later arrives back
          // via Redis (once it recovers) is a no-op.
          void this.deliverSignal(signal);
          void publishRealtimeSignalBestEffort(this.publisher?.isReady ? this.publisher : null, signal, (error) => {
            this.log.warn({ error }, "Realtime Redis publish failed; other instances will catch up from PostgreSQL");
            this.scheduleReconnect();
          });
        });
        client.on("error", (error) => {
          incrementRealtimeMetric("postgres_listener", "disconnect");
          this.log.warn({ error }, "Realtime PostgreSQL listener disconnected");
          if (this.postgresClient === client) this.postgresClient = null;
          this.scheduleReconnect();
        });
        await client.query(`LISTEN ${REALTIME_POSTGRES_CHANNEL}`);
        this.postgresClient = client;
        incrementRealtimeMetric("postgres_listener", "connect");
        this.log.info({}, "Realtime PostgreSQL listener connected");
      } catch (error) {
        incrementRealtimeMetric("postgres_listener", "disconnect");
        this.log.warn({ error }, "Realtime PostgreSQL listener unavailable; polling remains active");
        this.scheduleReconnect();
      }
    }
    if (!this.publisher?.isReady || !this.subscriber?.isReady) {
      await this.startRedis();
    }
  }

  private async startRedis(): Promise<void> {
    await Promise.allSettled([
      this.closeRedisClient(this.subscriber),
      this.closeRedisClient(this.publisher)
    ]);
    const socket = { connectTimeout: 1_000, reconnectStrategy: false as const };
    const publisher = createClient({ url: this.redisUrl, socket });
    const subscriber = createClient({ url: this.redisUrl, socket });
    publisher.on("error", (error) => {
      incrementRealtimeMetric("redis_publisher", "disconnect");
      this.log.warn({ error }, "Realtime Redis publisher error");
    });
    subscriber.on("error", (error) => {
      incrementRealtimeMetric("redis_subscriber", "disconnect");
      this.log.warn({ error }, "Realtime Redis subscriber error");
    });
    try {
      await Promise.all([publisher.connect(), subscriber.connect()]);
      await subscriber.subscribe(REALTIME_REDIS_CHANNEL, (payload) => {
        const signal = parseInternalRealtimeSignal(payload);
        if (signal) void this.deliverSignal(signal);
        else incrementRealtimeMetric("redis_subscriber", "parse_error");
      });
      this.publisher = publisher;
      this.subscriber = subscriber;
      incrementRealtimeMetric("redis_publisher", "connect");
      incrementRealtimeMetric("redis_subscriber", "connect");
      this.log.info({}, "Realtime Redis pub/sub connected");
    } catch (error) {
      incrementRealtimeMetric("redis_publisher", "disconnect");
      incrementRealtimeMetric("redis_subscriber", "disconnect");
      this.log.warn({ error }, "Realtime Redis unavailable; polling remains active");
      await Promise.allSettled([
        this.closeRedisClient(subscriber),
        this.closeRedisClient(publisher)
      ]);
      this.publisher = null;
      this.subscriber = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureStarted();
    }, 1_000);
    this.reconnectTimer.unref();
  }

  private async deliverSignal(signal: InternalRealtimeSignal): Promise<void> {
    try {
      if (signal.type === "conversation.messages.changed" || signal.type === "conversation.ai.progress") {
        const conversation = await this.pool.query<{ assigned_user_id: string | null }>(
          `SELECT assigned_user_id
           FROM conversations
           WHERE tenant_id=$1 AND id=$2`,
          [signal.tenantId, signal.conversationId]
        );
        this.hub.broadcast(signal, {
          assignedUserId: conversation.rows[0]?.assigned_user_id ?? null
        });
        return;
      }
      if (signal.type === "alerts.changed") {
        const receipts = await this.pool.query<{ user_id: string }>(
          `SELECT user_id
           FROM system_alert_receipts
           WHERE tenant_id=$1 AND alert_id=$2`,
          [signal.tenantId, signal.entityId]
        );
        this.hub.broadcast(signal, {
          visibleUserIds: new Set(receipts.rows.map((row) => row.user_id))
        });
        return;
      }
      this.hub.broadcast(signal);
    } catch (error) {
      // Workspace managers may still safely receive a coarse refresh event.
      // A missing audience must never widen delivery to operators.
      this.log.warn({ error, signalType: signal.type }, "Realtime audience resolution failed");
      this.hub.broadcast(signal);
    }
  }

  private async closeRedisClient(client: RedisClient | null): Promise<void> {
    if (!client?.isOpen) return;
    try {
      await client.quit();
    } catch {
      client.destroy();
    }
  }
}
