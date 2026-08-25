import type {
  FastifyRateLimitStore,
  FastifyRateLimitStoreCtor
} from "@fastify/rate-limit";
import type { FastifyRequest } from "fastify";
import { createClient } from "redis";

type RateLimitCallback = (
  error: Error | null,
  result?: { current: number; ttl: number }
) => void;

interface RateLimitStoreOptions {
  continueExceeding?: boolean;
  exponentialBackoff?: boolean;
  routeInfo?: { method?: string; url?: string };
}

interface LocalRateLimitBucket {
  current: number;
  expiresAt: number;
}

const MAX_LOCAL_RATE_LIMIT_BUCKETS = 10_000;

function pruneLocalRateLimitBuckets(
  buckets: Map<string, LocalRateLimitBucket>,
  now: number
): void {
  for (const [key, bucket] of buckets) {
    if (bucket.expiresAt <= now) buckets.delete(key);
  }

  while (buckets.size >= MAX_LOCAL_RATE_LIMIT_BUCKETS) {
    const oldestKey = buckets.keys().next().value;
    if (oldestKey === undefined) break;
    buckets.delete(oldestKey);
  }
}

export function incrementLocalRateLimit(
  buckets: Map<string, LocalRateLimitBucket>,
  key: string,
  timeWindow: number,
  max: number,
  continueExceeding: boolean,
  exponentialBackoff: boolean,
  now = Date.now()
): { current: number; ttl: number } {
  if (!buckets.has(key) && buckets.size >= MAX_LOCAL_RATE_LIMIT_BUCKETS) {
    pruneLocalRateLimitBuckets(buckets, now);
  }

  let bucket = buckets.get(key);
  if (!bucket || bucket.expiresAt <= now) {
    bucket = { current: 1, expiresAt: now + timeWindow };
    buckets.set(key, bucket);
    return { current: 1, ttl: timeWindow };
  }

  bucket.current += 1;
  if (continueExceeding && bucket.current > max) {
    bucket.expiresAt = now + timeWindow;
  } else if (exponentialBackoff && bucket.current > max) {
    const exponent = Math.min(bucket.current - max - 1, 20);
    bucket.expiresAt = now + timeWindow * 2 ** exponent;
  }
  return { current: bucket.current, ttl: Math.max(0, bucket.expiresAt - now) };
}

const INCREMENT_SCRIPT = `
  local current = redis.call('INCR', KEYS[1])
  local ttl = tonumber(ARGV[1])
  local maximum = tonumber(ARGV[2])
  local continue_exceeding = ARGV[3] == 'true'
  local exponential_backoff = ARGV[4] == 'true'

  if current == 1 or (continue_exceeding and current > maximum) then
    redis.call('PEXPIRE', KEYS[1], ttl)
  elseif exponential_backoff and current > maximum then
    local exponent = math.min(current - maximum - 1, 20)
    ttl = ttl * (2 ^ exponent)
    redis.call('PEXPIRE', KEYS[1], ttl)
  else
    ttl = redis.call('PTTL', KEYS[1])
  end

  return { current, ttl }
`;

export function httpRateLimitKey(request: FastifyRequest): string {
  // The limiter runs before route authentication. Using a presented API key,
  // webhook instance or unsigned JWT claims here would let an attacker rotate
  // untrusted values to create fresh buckets. The trusted-proxy-resolved IP is
  // the only stable identity available at this stage; the store already scopes
  // it independently by route/group.
  return `ip:${request.ip}`;
}

export const HTTP_RATE_LIMITS = {
  login: { max: 10, timeWindow: "1 minute", exponentialBackoff: true, groupId: "auth-login" },
  authentication: { max: 10, timeWindow: "1 minute", exponentialBackoff: true, groupId: "authentication" },
  invitationRead: { max: 60, timeWindow: "1 minute", groupId: "invitation-read" },
  invitationWrite: { max: 20, timeWindow: "1 minute", groupId: "invitation-write" },
  webhook: { max: 600, timeWindow: "1 minute", groupId: "evolution-webhook" },
  publicApiRead: { max: 120, timeWindow: "1 minute", groupId: "public-api-read" },
  publicApiWrite: { max: 60, timeWindow: "1 minute", groupId: "public-api-write" },
  sensitiveWrite: { max: 30, timeWindow: "1 minute", groupId: "sensitive-write" },
  upload: { max: 12, timeWindow: "1 minute", groupId: "upload" },
  export: { max: 10, timeWindow: "1 minute", groupId: "export" },
  tripzWrite: { max: 30, timeWindow: "1 minute", groupId: "tripz-write" },
  tripzUpload: { max: 12, timeWindow: "1 minute", groupId: "tripz-upload" },
  tripzExport: { max: 10, timeWindow: "1 minute", groupId: "tripz-export" }
} as const;

export function createRedisRateLimitStore(
  redisUrl: string,
  onError: (error: Error) => void
): {
  Store: FastifyRateLimitStoreCtor;
  close(): Promise<void>;
} {
  type RateLimitRedisClient = ReturnType<typeof createClient>;
  let client: RateLimitRedisClient | undefined;
  let connection: Promise<RateLimitRedisClient> | undefined;
  const localBuckets = new Map<string, LocalRateLimitBucket>();

  const connectedClient = async (): Promise<RateLimitRedisClient> => {
    if (client?.isReady) return client;
    if (!connection) {
      const pendingClient = createClient({
        url: redisUrl,
        disableOfflineQueue: true,
        socket: { connectTimeout: 3_000, reconnectStrategy: false }
      });
      client = pendingClient;
      pendingClient.on("error", (error: Error) => onError(error));
      const pendingConnection = pendingClient.connect()
        .then(() => pendingClient)
        .catch((error: unknown) => {
          if (client === pendingClient) client = undefined;
          if (connection === pendingConnection) connection = undefined;
          throw error;
        });
      connection = pendingConnection;
    }
    return connection!;
  };

  class RedisRateLimitStore implements FastifyRateLimitStore {
    private readonly prefix: string;
    private readonly continueExceeding: boolean;
    private readonly exponentialBackoff: boolean;

    constructor(rawOptions: unknown = {}) {
      const options = rawOptions as RateLimitStoreOptions;
      this.continueExceeding = options.continueExceeding === true;
      this.exponentialBackoff = options.exponentialBackoff === true;
      const method = options.routeInfo?.method ?? "GLOBAL";
      const route = options.routeInfo?.url ?? "/";
      this.prefix = `atendon:http-rate-limit:${method}:${route}:`;
    }

    incr(key: string, callback: RateLimitCallback, timeWindow: number, max: number): void {
      const storeKey = `${this.prefix}${key}`;
      void connectedClient()
        .then((redis) => redis.eval(INCREMENT_SCRIPT, {
          keys: [storeKey],
          arguments: [
            String(timeWindow),
            String(max),
            String(this.continueExceeding),
            String(this.exponentialBackoff)
          ]
        }))
        .then((raw) => {
          const result = raw as [number, number];
          callback(null, { current: Number(result[0]), ttl: Math.max(0, Number(result[1])) });
        })
        .catch((error: unknown) => {
          const normalized = error instanceof Error ? error : new Error(String(error));
          const active = client;
          client = undefined;
          connection = undefined;
          if (active?.isOpen) void active.disconnect().catch(() => undefined);
          onError(normalized);
          callback(null, incrementLocalRateLimit(
            localBuckets,
            storeKey,
            timeWindow,
            max,
            this.continueExceeding,
            this.exponentialBackoff
          ));
        });
    }

    child(
      rawOptions: Parameters<FastifyRateLimitStore["child"]>[0]
    ): FastifyRateLimitStore {
      const options = rawOptions as unknown as RateLimitStoreOptions;
      return new RedisRateLimitStore(options);
    }
  }

  return {
    Store: RedisRateLimitStore,
    async close() {
      const active = client;
      client = undefined;
      connection = undefined;
      localBuckets.clear();
      if (active?.isOpen) await active.quit();
    }
  };
}
