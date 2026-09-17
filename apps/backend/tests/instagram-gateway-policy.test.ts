import { describe, expect, it, vi } from "vitest";
import { InstagramGateway } from "../src/modules/instagram/gateway.js";
import type {
  InstagramProvider,
  ProviderSendResult
} from "../src/modules/instagram/types.js";

function accepted(externalId = "mid-1"): ProviderSendResult {
  return { outcome: "accepted", externalId };
}

function providerDouble() {
  const sendText = vi.fn<InstagramProvider["sendText"]>().mockResolvedValue(accepted());
  const sendMedia = vi.fn<InstagramProvider["sendMedia"]>().mockResolvedValue(accepted());
  const provider: InstagramProvider = {
    exchangeOAuthCode: vi.fn(),
    refreshAccessToken: vi.fn(),
    subscribeWebhook: vi.fn(),
    fetchUserProfile: vi.fn().mockResolvedValue({ username: null, name: null, profilePictureUrl: null }),
    sendText,
    sendMedia,
    fetchMedia: vi.fn()
  };
  return { provider, sendText, sendMedia };
}

function repositoryDouble(input?: {
  connection?: {
    id: string;
    provider_account_id: string;
    status: string;
    archived_at: Date | null;
    token_expires_at: Date | null;
  } | null;
  window?: { expiresAt: Date | null; conversationId: string } | null;
}) {
  const connection = input && "connection" in input
    ? input.connection
    : {
      id: "connection-uuid",
      provider_account_id: "account-1",
      status: "connected",
      archived_at: null,
      token_expires_at: new Date("2026-09-16T00:00:00.000Z")
    };
  const window = input && "window" in input
    ? input.window
    : {
      expiresAt: new Date("2026-09-15T01:00:00.000Z"),
      conversationId: "conversation-1"
    };
  return {
    findConnection: vi.fn().mockResolvedValue(connection),
    getToken: vi.fn().mockResolvedValue("access-token"),
    getConversationWindow: vi.fn().mockResolvedValue(window)
  };
}

describe("InstagramGateway database policy", () => {
  it("uses the connection UUID and authoritative DB window for a text send", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
    const repository = repositoryDouble();
    const provider = providerDouble();
    const gateway = new InstagramGateway(repository, provider.provider);

    await expect(gateway.sendText({
      tenantId: "tenant-1",
      connectionId: "connection-uuid",
      recipientId: "igsid-1",
      text: "hello",
      windowExpiresAt: new Date("2020-01-01T00:00:00.000Z")
    })).resolves.toEqual(accepted());

    expect(repository.findConnection).toHaveBeenCalledWith("tenant-1", "connection-uuid");
    expect(repository.getToken).toHaveBeenCalledWith("tenant-1", "connection-uuid");
    expect(repository.getConversationWindow).toHaveBeenCalledWith(
      "tenant-1",
      "connection-uuid",
      "igsid-1"
    );
    expect(provider.sendText).toHaveBeenCalledWith({
      instagramAccountId: "account-1",
      recipientId: "igsid-1",
      accessToken: "access-token",
      text: "hello"
    });
    vi.useRealTimers();
  });

  it.each([
    ["missing", null],
    ["unknown expiry", { expiresAt: null, conversationId: "conversation-1" }],
    ["expired", {
      expiresAt: new Date("2026-09-15T00:00:00.000Z"),
      conversationId: "conversation-1"
    }]
  ])("fails closed when the DB window is %s", async (_label, window) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
    const repository = repositoryDouble({ window });
    const provider = providerDouble();
    const gateway = new InstagramGateway(repository, provider.provider);

    await expect(gateway.sendText({
      tenantId: "tenant-1",
      connectionId: "connection-uuid",
      recipientId: "igsid-1",
      text: "hello",
      windowExpiresAt: new Date("2099-01-01T00:00:00.000Z")
    })).resolves.toEqual({
      outcome: "rejected",
      code: "window_expired",
      message: "Janela de 24 horas expirada"
    });
    expect(provider.sendText).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it.each([
    ["disconnected", { status: "disconnected", archived_at: null }],
    ["archived", { status: "connected", archived_at: new Date("2026-09-14T00:00:00Z") }]
  ])("does not send through a %s connection", async (_label, state) => {
    const repository = repositoryDouble({
      connection: {
        id: "connection-uuid",
        provider_account_id: "account-1",
        status: state.status,
        archived_at: state.archived_at,
        token_expires_at: new Date("2099-01-01T00:00:00.000Z")
      }
    });
    const provider = providerDouble();
    const gateway = new InstagramGateway(repository, provider.provider);

    await expect(gateway.sendText({
      tenantId: "tenant-1",
      connectionId: "connection-uuid",
      recipientId: "igsid-1",
      text: "hello"
    })).rejects.toThrow("Instagram connection is not connected");
    expect(provider.sendText).not.toHaveBeenCalled();
  });

  it.each([
    [null],
    [new Date("2026-09-15T00:00:00.000Z")]
  ])("does not send with an absent or expired token expiry", async (tokenExpiresAt) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
    const repository = repositoryDouble({
      connection: {
        id: "connection-uuid",
        provider_account_id: "account-1",
        status: "connected",
        archived_at: null,
        token_expires_at: tokenExpiresAt
      }
    });
    const provider = providerDouble();
    const gateway = new InstagramGateway(repository, provider.provider);

    await expect(gateway.sendText({
      tenantId: "tenant-1",
      connectionId: "connection-uuid",
      recipientId: "igsid-1",
      text: "hello"
    })).rejects.toThrow("Instagram token expired");
    expect(repository.getToken).not.toHaveBeenCalled();
    expect(provider.sendText).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("applies the same DB window gate to media", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
    const repository = repositoryDouble({ window: null });
    const provider = providerDouble();
    const gateway = new InstagramGateway(repository, provider.provider);

    await expect(gateway.sendMedia({
      tenantId: "tenant-1",
      connectionId: "connection-uuid",
      recipientId: "igsid-1",
      media: { type: "image", url: "https://cdn.example/image.png" }
    })).resolves.toMatchObject({ outcome: "rejected", code: "window_expired" });
    expect(provider.sendMedia).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
