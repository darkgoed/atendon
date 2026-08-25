import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import { config } from "../../config.js";

let redisClient: RedisClientType | null = null;

async function getRedisClient(): Promise<RedisClientType> {
  if (redisClient?.isOpen) return redisClient;
  const url = config.REDIS_URL;
  redisClient = createClient({ url });
  redisClient.on("error", (err: Error) => console.error("Redis rate limiter error:", err));
  await redisClient.connect();
  return redisClient;
}

export async function consumeRateLimitRedis(key: string, maximum: number, windowMs = 60_000): Promise<boolean> {
  const client = await getRedisClient();
  const now = Date.now();
  const windowStart = now - windowMs;
  const redisKey = `ratelimit:${key}`;
  const accepted = await client.eval(`
    redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[2])
    if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then
      return 0
    end
    redis.call('ZADD', KEYS[1], ARGV[1], ARGV[5])
    redis.call('PEXPIRE', KEYS[1], ARGV[4])
    return 1
  `, {
    keys: [redisKey],
    arguments: [String(now), String(windowStart), String(maximum), String(windowMs + 5_000), `${now}:${randomUUID()}`]
  });
  return accepted === 1;
}

export async function closeRateLimiter(): Promise<void> {
  if (redisClient?.isOpen) {
    await redisClient.quit();
    redisClient = null;
  }
}
