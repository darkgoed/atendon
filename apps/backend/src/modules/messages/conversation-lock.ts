import { createClient, type RedisClientType } from "redis";
import { config } from "../../config.js";

let redisClient: RedisClientType | null = null;

async function getRedisClient(): Promise<RedisClientType> {
  if (redisClient?.isOpen) return redisClient;
  redisClient = createClient({ url: config.REDIS_URL });
  redisClient.on("error", (err: Error) => console.error("Redis conversation lock error:", err));
  await redisClient.connect();
  return redisClient;
}

// Compare-and-delete so a lock is only released by the holder that acquired
// it (a slow job past its TTL must never delete a newer holder's lock).
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

// Compare-and-pexpire so only the current holder can extend its own TTL.
const EXTEND_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`;

export interface ConversationLock {
  redisKey: string;
  token: string;
}

export async function isConversationLocked(key: string): Promise<boolean> {
  const client = await getRedisClient();
  return (await client.exists(`conv-lock:${key}`)) > 0;
}

// Serializes AI reply generation per conversation (per tenant+contact). Two
// inbound messages from the same contact that miss the debounce coalescing
// window (e.g. arriving seconds apart while the first AI call is still in
// flight) would otherwise each win their own debounce cycle and call the
// model concurrently, producing two independent, contradictory replies.
// Returns null if the lock could not be acquired within waitMs (another job
// for this conversation is still running); callers should release their
// processing lease and retry later.
export async function acquireConversationLock(
  key: string,
  { ttlMs = 60_000, waitMs = 45_000, pollIntervalMs = 200 }: { ttlMs?: number; waitMs?: number; pollIntervalMs?: number } = {}
): Promise<ConversationLock | null> {
  const client = await getRedisClient();
  const redisKey = `conv-lock:${key}`;
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const acquired = await client.set(redisKey, token, { NX: true, PX: ttlMs });
    if (acquired) return { redisKey, token };
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

// A humanized turn (debounce + typing pauses + tool iterations) can outlast
// the lock TTL; without extension, a BullMQ retry or concurrent job acquires
// the expired lock mid-turn and sends a second full reply. Returns false when
// the lock is no longer held by this token.
export async function extendConversationLock(lock: ConversationLock, ttlMs = 60_000): Promise<boolean> {
  const client = await getRedisClient();
  const result = await client.eval(EXTEND_SCRIPT, { keys: [lock.redisKey], arguments: [lock.token, String(ttlMs)] });
  return result === 1;
}

export async function releaseConversationLock(lock: ConversationLock): Promise<void> {
  const client = await getRedisClient();
  await client.eval(RELEASE_SCRIPT, { keys: [lock.redisKey], arguments: [lock.token] });
}

export async function closeConversationLock(): Promise<void> {
  if (redisClient?.isOpen) {
    await redisClient.quit();
    redisClient = null;
  }
}
