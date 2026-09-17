import type { Pool } from "pg";
import { config, type AppConfig } from "../../config.js";
import { db } from "../../db/client.js";
import { logger } from "../../logger.js";
import { MetaInstagramProvider } from "./provider.js";
import { InstagramRepository } from "./repository.js";
import { InstagramService } from "./service.js";
import { InstagramGateway } from "./gateway.js";
import { InstagramOAuthStore } from "./oauth.js";
import type { InstagramProvider, InstagramRuntime } from "./types.js";

export interface CreateInstagramRuntimeOptions {
  database?: Pick<Pool, "connect" | "query">;
  runtimeConfig?: AppConfig;
  provider?: InstagramProvider;
}

export function createInstagramRuntime(options: CreateInstagramRuntimeOptions = {}): InstagramRuntime & {
  oauth: InstagramOAuthStore;
} {
  const runtimeConfig = options.runtimeConfig ?? config;
  const database = options.database ?? db;
  const provider = options.provider ?? new MetaInstagramProvider({
    appId: runtimeConfig.INSTAGRAM_APP_ID ?? "",
    appSecret: runtimeConfig.INSTAGRAM_APP_SECRET ?? "",
    graphVersion: runtimeConfig.INSTAGRAM_GRAPH_VERSION,
    timeoutMs: runtimeConfig.INSTAGRAM_TIMEOUT_MS,
    mediaMaxBytes: runtimeConfig.INSTAGRAM_MEDIA_MAX_BYTES,
    onTokenExchangeRejected: (error) => {
      logger.warn(
        { err: error, context: "instagram_long_lived_token_exchange" },
        "Instagram recusou a troca pelo token de 60 dias; conexão segue com o token curto até o próximo refresh"
      );
    }
  });
  const repository = new InstagramRepository(database, {
    current: runtimeConfig.DATA_ENCRYPTION_KEY,
    previous: runtimeConfig.DATA_ENCRYPTION_KEY_PREVIOUS
      ? [runtimeConfig.DATA_ENCRYPTION_KEY_PREVIOUS]
      : []
  }, runtimeConfig.INSTAGRAM_MAX_CONNECTIONS);
  const service = new InstagramService(repository, provider);
  return {
    provider,
    repository,
    service,
    gateway: new InstagramGateway(repository, provider),
    oauth: new InstagramOAuthStore(database)
  };
}

export { InstagramGateway } from "./gateway.js";
export {
  createInstagramInboxDispatcher,
  drainInstagramInboxTenant,
  instagramInboundExternalId
} from "./dispatch.js";
export { InstagramOAuthStore, createOAuthState, hashOAuthBrowserNonce } from "./oauth.js";
export { InstagramRepository } from "./repository.js";
export { registerInstagramRoutes } from "./routes.js";
export { InstagramService } from "./service.js";
export { InstagramWorkerScheduler } from "./worker-scheduler.js";
