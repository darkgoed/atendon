import type { InstagramProvider, OAuthIdentity } from "./types.js";
import { InstagramRepository } from "./repository.js";

const REQUIRED_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages"
] as const;

function hasProviderRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ("providerRejected" in error
    && (error as Error & { providerRejected?: boolean }).providerRejected === true) {
    return true;
  }
  if ("status" in error) {
    const status = (error as Error & { status?: unknown }).status;
    return typeof status === "number" && status >= 400 && status < 500;
  }
  return false;
}

function refreshStaleError(): Error {
  return Object.assign(new Error("Instagram credential changed while refresh was in progress"), {
    statusCode: 409,
    code: "INSTAGRAM_REFRESH_STALE"
  });
}

function oauthStaleError(): Error {
  return Object.assign(new Error("Instagram connection changed while OAuth was in progress"), {
    statusCode: 409,
    code: "INSTAGRAM_OAUTH_STALE"
  });
}

export interface ConnectInstagramOAuthInput {
  tenantId: string;
  label: string;
  connectionId?: string | null;
  code: string;
  redirectUri: string;
}

export interface RefreshDueResult {
  refreshed: number;
  revoked: number;
  failed: number;
}

export class InstagramService {
  constructor(
    readonly repository: InstagramRepository,
    readonly provider: InstagramProvider
  ) {}

  async connectOAuth(input: ConnectInstagramOAuthInput): Promise<OAuthIdentity> {
    const identity = await this.provider.exchangeOAuthCode({
      code: input.code,
      redirectUri: input.redirectUri
    });
    const missingScope = REQUIRED_SCOPES.find((scope) => !identity.scopes.includes(scope));
    if (missingScope) {
      throw Object.assign(new Error("Instagram authorization is missing a required permission"), {
        statusCode: 400,
        code: "INSTAGRAM_REQUIRED_SCOPE_MISSING"
      });
    }
    const connection = await this.repository.saveConnection({
      tenantId: input.tenantId,
      id: input.connectionId ?? undefined,
      label: input.label,
      accountId: identity.accountId,
      username: identity.username,
      accessToken: identity.accessToken,
      expiresAt: identity.tokenExpiresAt
    });
    try {
      await this.provider.subscribeWebhook({
        instagramAccountId: identity.accountId,
        accessToken: identity.accessToken
      });
    } catch (error) {
      await this.repository.markConnectionRevoked(
        input.tenantId,
        connection.id,
        "webhook_subscription_failed",
        connection.credentials_encrypted ?? undefined
      );
      throw error;
    }
    const finalized = await this.repository.finalizeOAuthConnection(
      input.tenantId,
      connection.id,
      connection.credentials_encrypted!
    );
    if (!finalized) throw oauthStaleError();
    return identity;
  }

  async refresh(tenantId: string, connectionId: string): Promise<{ ok: true }> {
    const snapshot = await this.repository.getTokenSnapshot(tenantId, connectionId);
    let refreshed: Awaited<ReturnType<InstagramProvider["refreshAccessToken"]>>;
    try {
      refreshed = await this.provider.refreshAccessToken({ accessToken: snapshot.token });
    } catch (error) {
      if (hasProviderRejection(error)) {
        const revoked = await this.repository.markConnectionRevoked(
          tenantId,
          connectionId,
          "token_revoked",
          snapshot.encrypted
        );
        if (!revoked) throw refreshStaleError();
        throw Object.assign(new Error("Instagram authorization was revoked; reconnect the account"), {
          statusCode: 409,
          code: "INSTAGRAM_REAUTH_REQUIRED"
        });
      }
      throw Object.assign(new Error("Instagram token refresh result is unknown; try again later"), {
        statusCode: 502,
        code: "INSTAGRAM_REFRESH_AMBIGUOUS"
      });
    }
    const updated = await this.repository.updateToken(
      tenantId,
      connectionId,
      refreshed.accessToken,
      refreshed.expiresAt,
      snapshot.encrypted
    );
    if (!updated) throw refreshStaleError();
    return { ok: true };
  }

  async disconnect(tenantId: string, connectionId: string): Promise<{ ok: true }> {
    const disconnected = await this.repository.disconnect(tenantId, connectionId);
    if (!disconnected) {
      throw Object.assign(new Error("Instagram connection not found"), {
        statusCode: 404,
        code: "INSTAGRAM_CONNECTION_NOT_FOUND"
      });
    }
    return { ok: true };
  }

  async refreshDueTokens(
    cutoff = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  ): Promise<RefreshDueResult> {
    const due = await this.repository.refreshDueTokens(cutoff);
    const result: RefreshDueResult = { refreshed: 0, revoked: 0, failed: 0 };
    for (const token of due) {
      try {
        await this.refresh(token.tenantId, token.connectionId);
        result.refreshed += 1;
      } catch (error) {
        if (error instanceof Error
          && "code" in error
          && (error as Error & { code?: string }).code === "INSTAGRAM_REAUTH_REQUIRED") {
          result.revoked += 1;
        } else {
          result.failed += 1;
        }
      }
    }
    return result;
  }

  async drainWebhookEvents(
    tenantId: string,
    callback: (event: Record<string, unknown>) => Promise<void> | void
  ): Promise<number> {
    const rows = await this.repository.claimInbox(tenantId);
    for (const row of rows) {
      try {
        await callback(row);
        await this.repository.markProcessed(tenantId, String(row.id));
      } catch (error) {
        await this.repository.markProcessed(
          tenantId,
          String(row.id),
          error instanceof Error ? error.message : "processing failed"
        );
      }
    }
    return rows.length;
  }
}
