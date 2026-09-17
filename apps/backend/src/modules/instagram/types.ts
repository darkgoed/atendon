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
  /**
   * Perfil público do contato (IGSID), usado para preencher nome/@/foto que o
   * webhook de mensagem não entrega. Best effort: campos ausentes ou a chamada
   * inteira podem falhar (janela de mensageria fechada, permissão, conta
   * apagada) sem que isso derrube o processamento da mensagem — trate como
   * enriquecimento opcional, nunca como dependência obrigatória.
   */
  fetchUserProfile(input: {
    instagramScopedUserId: string;
    accessToken: string;
  }): Promise<{ username: string | null; name: string | null; profilePictureUrl: string | null }>;
};

export type InstagramRuntime = {
  provider: InstagramProvider;
  repository: import("./repository.js").InstagramRepository;
  service: import("./service.js").InstagramService;
  gateway: import("./gateway.js").InstagramGateway;
};
