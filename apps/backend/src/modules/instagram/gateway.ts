import type {
  InstagramProvider,
  OutboundMedia,
  ProviderSendResult
} from "./types.js";

export type InstagramGatewayConnection = {
  id: string;
  provider_account_id: string;
  status: string;
  archived_at: Date | string | null;
  token_expires_at: Date | string | null;
};

export type InstagramConversationWindow = {
  expiresAt: Date | null;
  conversationId: string;
};

export type InstagramGatewayRepository = {
  findConnection(
    tenantId: string,
    connectionUUID: string
  ): Promise<InstagramGatewayConnection | null>;
  getToken(tenantId: string, connectionUUID: string): Promise<string>;
  getConversationWindow(
    tenantId: string,
    connectionUUID: string,
    instagramScopedUserId: string
  ): Promise<InstagramConversationWindow | null>;
};

export type InstagramTextSendInput = {
  tenantId: string;
  connectionId: string;
  recipientId: string;
  text: string;
  /** @deprecated The database window is authoritative; this value is ignored. */
  windowExpiresAt?: Date;
};

export type InstagramMediaSendInput = {
  tenantId: string;
  connectionId: string;
  recipientId: string;
  media: OutboundMedia;
  /** @deprecated The database window is authoritative; this value is ignored. */
  windowExpiresAt?: Date;
};

const WINDOW_REJECTED: ProviderSendResult = {
  outcome: "rejected",
  code: "window_expired",
  message: "Janela de 24 horas expirada"
};

function validFutureDate(value: Date | string | null): boolean {
  if (value === null) return false;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

export class InstagramGateway {
  constructor(
    private readonly repo: InstagramGatewayRepository,
    private readonly provider: InstagramProvider
  ) {}

  private async authorize(input: {
    tenantId: string;
    connectionId: string;
    recipientId: string;
  }): Promise<{
    instagramAccountId: string;
    accessToken: string;
  } | null> {
    const connection = await this.repo.findConnection(input.tenantId, input.connectionId);
    if (!connection) throw new Error("Instagram connection not found");
    if (connection.status !== "connected" || connection.archived_at !== null) {
      throw new Error("Instagram connection is not connected");
    }
    if (!validFutureDate(connection.token_expires_at)) {
      throw new Error("Instagram token expired");
    }

    const window = await this.repo.getConversationWindow(
      input.tenantId,
      input.connectionId,
      input.recipientId
    );
    if (!window || !validFutureDate(window.expiresAt)) return null;

    return {
      instagramAccountId: connection.provider_account_id,
      accessToken: await this.repo.getToken(input.tenantId, input.connectionId)
    };
  }

  async sendText(input: InstagramTextSendInput): Promise<ProviderSendResult> {
    const authorized = await this.authorize(input);
    if (!authorized) return WINDOW_REJECTED;
    return this.provider.sendText({
      instagramAccountId: authorized.instagramAccountId,
      recipientId: input.recipientId,
      accessToken: authorized.accessToken,
      text: input.text
    });
  }

  async sendMedia(input: InstagramMediaSendInput): Promise<ProviderSendResult> {
    const authorized = await this.authorize(input);
    if (!authorized) return WINDOW_REJECTED;
    return this.provider.sendMedia({
      instagramAccountId: authorized.instagramAccountId,
      recipientId: input.recipientId,
      accessToken: authorized.accessToken,
      media: input.media
    });
  }
}
