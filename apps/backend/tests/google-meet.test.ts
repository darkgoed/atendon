import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_MEET_CREATE_SCOPE,
  GoogleMeetApiError,
  GoogleMeetClient,
  GoogleMeetClientCache,
  GoogleMeetConfigurationError,
  GoogleMeetOAuthClient,
  createGoogleMeetOAuthState,
  verifyGoogleMeetOAuthState
} from "../src/modules/scheduling/google-meet.js";

const runtimeConfig = {
  oauthClientId: "oauth-client.apps.googleusercontent.com",
  oauthClientSecret: "oauth-secret",
  refreshToken: "refresh-token",
  GOOGLE_MEET_TOKEN_URL: "https://oauth2.googleapis.test/token",
  GOOGLE_MEET_API_BASE_URL: "https://meet.googleapis.test",
  GOOGLE_MEET_TIMEOUT_MS: 5_000
};

describe("GoogleMeetClient", () => {
  it("renews user OAuth and creates a space directly through the Meet REST API", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "meet-access-token",
        expires_in: 3600,
        token_type: "Bearer"
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "spaces/space-1",
        meetingUri: "https://meet.google.com/abc-defg-hij",
        meetingCode: "abc-defg-hij"
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new GoogleMeetClient(runtimeConfig, fetcher as unknown as typeof fetch, () => new Date("2026-07-17T12:00:00.000Z").getTime());

    await expect(client.createSpace()).resolves.toEqual({
      name: "spaces/space-1",
      meetingUri: "https://meet.google.com/abc-defg-hij",
      meetingCode: "abc-defg-hij"
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const tokenBody = fetcher.mock.calls[0][1]?.body as URLSearchParams;
    expect(Object.fromEntries(tokenBody)).toEqual({
      grant_type: "refresh_token",
      client_id: runtimeConfig.oauthClientId,
      client_secret: runtimeConfig.oauthClientSecret,
      refresh_token: runtimeConfig.refreshToken
    });
    expect(fetcher.mock.calls[1][0]).toBe("https://meet.googleapis.test/v2/spaces");
    expect(fetcher.mock.calls[1][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ config: { accessType: "OPEN" } }),
      headers: { authorization: "Bearer meet-access-token", "content-type": "application/json" }
    });
  });

  it("fails closed when OAuth credentials are absent", async () => {
    const client = new GoogleMeetClient({
      GOOGLE_MEET_TOKEN_URL: runtimeConfig.GOOGLE_MEET_TOKEN_URL,
      GOOGLE_MEET_API_BASE_URL: runtimeConfig.GOOGLE_MEET_API_BASE_URL,
      GOOGLE_MEET_TIMEOUT_MS: runtimeConfig.GOOGLE_MEET_TIMEOUT_MS
    });
    expect(client.isConfigured()).toBe(false);
    await expect(client.createSpace()).rejects.toBeInstanceOf(GoogleMeetConfigurationError);
  });

  it("classifies an ambiguous spaces.create timeout and never hides it as a safe retry", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "meet-access-token",
        expires_in: 3600
      }), { status: 200 }))
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    const client = new GoogleMeetClient(runtimeConfig, fetcher as unknown as typeof fetch);
    const prepared = await client.prepareCreateSpace();
    const error = await prepared.createSpace().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoogleMeetApiError);
    expect(error).toMatchObject({ outcome: "uncertain", phase: "space_create" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("caches a token-bearing client per tenant until credentials rotate", () => {
    const factory = vi.fn((credentials) => new GoogleMeetClient({
      ...runtimeConfig,
      ...credentials
    }));
    const cache = new GoogleMeetClientCache(factory);
    const credentials = {
      oauthClientId: "client",
      oauthClientSecret: "secret",
      refreshToken: "refresh"
    };
    expect(cache.get("tenant-a", credentials)).toBe(cache.get("tenant-a", credentials));
    expect(cache.get("tenant-b", credentials)).not.toBe(cache.get("tenant-a", credentials));
    expect(cache.get("tenant-a", { ...credentials, refreshToken: "rotated" }))
      .not.toBe(cache.get("tenant-a", credentials));
    expect(factory).toHaveBeenCalledTimes(4);
  });
});

describe("GoogleMeetOAuthClient", () => {
  const oauthConfig = {
    GOOGLE_MEET_TOKEN_URL: "https://oauth2.googleapis.test/token",
    GOOGLE_MEET_TIMEOUT_MS: 5_000,
    GOOGLE_MEET_OAUTH_AUTH_URL: "https://accounts.google.test/o/oauth2/v2/auth",
    GOOGLE_MEET_OAUTH_USERINFO_URL: "https://openidconnect.googleapis.test/v1/userinfo",
    GOOGLE_MEET_OAUTH_CLIENT_ID: "client.apps.googleusercontent.com",
    GOOGLE_MEET_OAUTH_CLIENT_SECRET: "client-secret",
    GOOGLE_MEET_OAUTH_REDIRECT_URI: "https://app.test/backend/scheduling/config/google-meet/oauth/callback"
  };

  it("builds consent URL and exchanges the authorization code for a refresh token", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ email: "Owner@Example.com", email_verified: true }), { status: 200 }));
    const client = new GoogleMeetOAuthClient(oauthConfig, fetcher as unknown as typeof fetch);
    const authorization = new URL(client.authorizationUrl("signed-state"));
    expect(authorization.searchParams.get("scope")?.split(" ")).toContain(GOOGLE_MEET_CREATE_SCOPE);
    expect(authorization.searchParams.get("access_type")).toBe("offline");
    expect(authorization.searchParams.get("prompt")).toBe("consent");

    await expect(client.exchangeCode("authorization-code")).resolves.toEqual({
      email: "owner@example.com",
      refreshToken: "refresh"
    });
  });

  it("signs short-lived state bound to the workspace user", async () => {
    const input = { tenantId: "8cde15b7-d8ac-4120-95a8-40e8afed28b3", userId: "d21c09ad-9b75-429c-badb-1458a8180463" };
    const state = await createGoogleMeetOAuthState(input, "state-secret-with-more-than-thirty-two-characters");
    await expect(verifyGoogleMeetOAuthState(state, "state-secret-with-more-than-thirty-two-characters")).resolves.toEqual(input);
    await expect(verifyGoogleMeetOAuthState(state, "another-secret-with-more-than-thirty-two-chars")).rejects.toBeInstanceOf(GoogleMeetConfigurationError);
  });
});
