export type InstagramMediaType = "image" | "audio" | "video" | "file";

export type ProviderSendResult =
  | { outcome: "accepted"; externalId: string }
  | { outcome: "rejected"; code: string; message: string }
  | { outcome: "ambiguous"; code: "ambiguous"; message: string };

export type OAuthIdentity = {
  accountId: string;
  username: string | null;
  accessToken: string;
  tokenExpiresAt: Date;
  scopes: string[];
};

export type TokenResult = {
  accessToken: string;
  expiresAt: Date;
};

export type OutboundMedia = {
  type: InstagramMediaType;
  url: string;
};

export type DownloadedMedia = {
  bytes: Buffer;
  contentType: string;
  sizeBytes: number;
  finalUrl: string;
};

export type NormalizedInstagramEvent = {
  kind: "message" | "read" | "reaction" | "postback" | "referral";
  eventId: string;
  accountId: string;
  providerUserId: string;
  providerThreadId?: string;
  externalId?: string;
  timestamp: Date;
  text?: string;
  media?: Array<{
    type: InstagramMediaType;
    url: string;
  }>;
  isEcho: boolean;
  raw: unknown;
};

export type InstagramProvider = {
  exchangeOAuthCode(input: {
    code: string;
    redirectUri: string;
  }): Promise<OAuthIdentity>;
  refreshAccessToken(input: { accessToken: string }): Promise<TokenResult>;
  subscribeWebhook(input: {
    instagramAccountId: string;
    accessToken: string;
  }): Promise<void>;
  sendText(input: {
    instagramAccountId: string;
    recipientId: string;
    accessToken: string;
    text: string;
  }): Promise<ProviderSendResult>;
  sendMedia(input: {
    instagramAccountId: string;
    recipientId: string;
    accessToken: string;
    media: OutboundMedia;
  }): Promise<ProviderSendResult>;
  fetchMedia(input: {
    url: string;
    accessToken: string;
  }): Promise<DownloadedMedia>;
};

export type InstagramRuntime = {
  provider: InstagramProvider;
  repository: import("./repository.js").InstagramRepository;
  service: import("./service.js").InstagramService;
  gateway: import("./gateway.js").InstagramGateway;
};
