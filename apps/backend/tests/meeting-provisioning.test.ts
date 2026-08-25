import { describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../src/modules/ai-router/secret-box.js";
import {
  GoogleMeetApiError,
  GoogleMeetClientCache
} from "../src/modules/scheduling/google-meet.js";
import {
  lateMeetingDeliveryEnabled,
  MeetingProvisioningProcessor,
  type MeetingProvisioningRepository
} from "../src/modules/scheduling/meeting-provisioning.js";

const encryptionKey = "meeting-provisioning-test-key-with-32-bytes";
const claimed = {
  id: "18bcdbd9-122a-4518-adfb-09285cdb6cb7",
  tenantId: "63b1db60-461b-458a-a606-e5ab557465a7",
  appointmentId: "b4f438c6-c51a-465e-9fe7-cdcdca878042",
  attemptCount: 1,
  encryptedRefreshToken: encryptSecret("refresh-token", encryptionKey)
};
const runtimeConfig = {
  DATA_ENCRYPTION_KEY: encryptionKey,
  DATA_ENCRYPTION_KEY_PREVIOUS: undefined,
  JWT_SECRET: "legacy-key-with-more-than-thirty-two-bytes",
  GOOGLE_MEET_OAUTH_CLIENT_ID: "client.apps.googleusercontent.com",
  GOOGLE_MEET_OAUTH_CLIENT_SECRET: "client-secret"
};

function repository(overrides: Record<string, unknown> = {}) {
  return {
    claim: vi.fn().mockResolvedValue(claimed),
    markAttemptStarted: vi.fn().mockResolvedValue(true),
    recordSafeFailure: vi.fn().mockResolvedValue("pending"),
    markReady: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    markUncertain: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

function processorWith(
  repo: ReturnType<typeof repository>,
  prepareCreateSpace: () => Promise<{ createSpace(): Promise<unknown> }>,
  enqueueContactDelivery: (outboxId: string) => Promise<void> = async () => undefined,
  refreshAppointmentNotification: (tenantId: string, appointmentId: string) => Promise<void> = async () => undefined
) {
  const cache = new GoogleMeetClientCache(() => ({ prepareCreateSpace }) as never);
  return new MeetingProvisioningProcessor(
    repo as unknown as MeetingProvisioningRepository,
    cache,
    runtimeConfig,
    enqueueContactDelivery,
    refreshAppointmentNotification
  );
}

describe("MeetingProvisioningProcessor", () => {
  it("keeps late delivery off for the default flag decision and fails closed if flags are unavailable", async () => {
    const defaultOffClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM feature_flag_definitions")) {
          return {
            rows: [{
              flag_key: "scheduling_meet_outbox_v2",
              description: "Meet outbox",
              default_enabled: false,
              global_enabled: null,
              kill_switch_enabled: false,
              tenant_override: null,
              updated_at: new Date().toISOString()
            }]
          };
        }
        return { rows: [] };
      })
    };
    await expect(lateMeetingDeliveryEnabled(
      defaultOffClient as never,
      claimed.tenantId
    )).resolves.toBe(false);

    const unavailableClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM feature_flag_definitions")) {
          throw new Error("relation unavailable");
        }
        return { rows: [] };
      })
    };
    await expect(lateMeetingDeliveryEnabled(
      unavailableClient as never,
      claimed.tenantId
    )).resolves.toBe(false);
    expect(unavailableClient.query.mock.calls.map(([sql]) => sql)).toEqual([
      "SAVEPOINT scheduling_meet_outbox_flag",
      expect.stringContaining("FROM feature_flag_definitions"),
      expect.stringContaining("FROM capability_dependencies"),
      "ROLLBACK TO SAVEPOINT scheduling_meet_outbox_flag",
      "RELEASE SAVEPOINT scheduling_meet_outbox_flag"
    ]);
  });

  it("marks attempted before exactly one spaces.create and finalizes ready", async () => {
    const calls: string[] = [];
    const repo = repository({
      markAttemptStarted: vi.fn(async () => {
        calls.push("attempted");
        return true;
      }),
      markReady: vi.fn(async () => {
        calls.push("ready");
      })
    });
    const createSpace = vi.fn(async () => {
      calls.push("http");
      return {
        name: "spaces/one",
        meetingUri: "https://meet.google.com/abc-defg-hij",
        meetingCode: "abc-defg-hij"
      };
    });
    const processor = processorWith(repo, async () => ({ createSpace }));

    await expect(processor.process(claimed.id)).resolves.toBe("ready");
    expect(calls).toEqual(["attempted", "http", "ready"]);
    expect(createSpace).toHaveBeenCalledTimes(1);
    expect(repo.markUncertain).not.toHaveBeenCalled();
  });

  it("retries only token preparation failures, before attempted_at exists", async () => {
    const repo = repository();
    const processor = processorWith(repo, async () => {
      throw new GoogleMeetApiError("token indisponível", "safe_to_retry", "oauth");
    });

    await expect(processor.process(claimed.id)).resolves.toBe("pending");
    expect(repo.recordSafeFailure).toHaveBeenCalledTimes(1);
    expect(repo.markAttemptStarted).not.toHaveBeenCalled();
    expect(repo.markUncertain).not.toHaveBeenCalled();
  });

  it("marks a timeout after spaces.create as uncertain and never retries it", async () => {
    const repo = repository();
    const createSpace = vi.fn().mockRejectedValue(
      new GoogleMeetApiError("resultado ambíguo", "uncertain", "space_create")
    );
    const processor = processorWith(repo, async () => ({ createSpace }));

    await expect(processor.process(claimed.id)).resolves.toBe("uncertain");
    expect(createSpace).toHaveBeenCalledTimes(1);
    expect(repo.markUncertain).toHaveBeenCalledTimes(1);
    expect(repo.recordSafeFailure).not.toHaveBeenCalled();
  });

  it("marks a definitive Google rejection as failed without another create call", async () => {
    const repo = repository();
    const createSpace = vi.fn().mockRejectedValue(
      new GoogleMeetApiError("HTTP 400", "failed", "space_create")
    );
    const processor = processorWith(repo, async () => ({ createSpace }));

    await expect(processor.process(claimed.id)).resolves.toBe("failed");
    expect(createSpace).toHaveBeenCalledTimes(1);
    expect(repo.markFailed).toHaveBeenCalledTimes(1);
    expect(repo.recordSafeFailure).not.toHaveBeenCalled();
  });

  it("keeps the committed ready state when queue enqueue fails so reconciliation can recover it", async () => {
    const repo = repository({
      markReady: vi.fn().mockResolvedValue("delivery-outbox-id")
    });
    const enqueue = vi.fn().mockRejectedValue(new Error("redis unavailable"));
    const processor = processorWith(repo, async () => ({
      createSpace: async () => ({
        name: "spaces/one",
        meetingUri: "https://meet.google.com/abc-defg-hij",
        meetingCode: "abc-defg-hij"
      })
    }), enqueue);

    await expect(processor.process(claimed.id)).resolves.toBe("ready");
    expect(repo.markReady).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith("delivery-outbox-id");
  });

  it("refreshes the WhatsApp group notification after the Meet link becomes ready", async () => {
    const repo = repository();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const processor = processorWith(
      repo,
      async () => ({
        createSpace: async () => ({
          name: "spaces/one",
          meetingUri: "https://meet.google.com/abc-defg-hij",
          meetingCode: "abc-defg-hij"
        })
      }),
      async () => undefined,
      refresh
    );

    await expect(processor.process(claimed.id)).resolves.toBe("ready");
    expect(refresh).toHaveBeenCalledWith(claimed.tenantId, claimed.appointmentId);
  });

  it("keeps Meet ready when the immediate WhatsApp refresh fails", async () => {
    const repo = repository();
    const refresh = vi.fn().mockRejectedValue(new Error("redis unavailable"));
    const processor = processorWith(
      repo,
      async () => ({
        createSpace: async () => ({
          name: "spaces/one",
          meetingUri: "https://meet.google.com/abc-defg-hij",
          meetingCode: "abc-defg-hij"
        })
      }),
      async () => undefined,
      refresh
    );

    await expect(processor.process(claimed.id)).resolves.toBe("ready");
    expect(refresh).toHaveBeenCalledOnce();
  });
});
