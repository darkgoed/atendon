import type { ConnectionOptions } from "bullmq";
import { config } from "../config.js";

const redis = new URL(config.REDIS_URL);
export const redisConnection: ConnectionOptions = {
  host: redis.hostname,
  port: Number(redis.port || 6379),
  username: redis.username || undefined,
  password: redis.password || undefined,
  db: redis.pathname.length > 1 ? Number(redis.pathname.slice(1)) : 0,
  ...(redis.protocol === "rediss:" ? { tls: {} } : {})
};
