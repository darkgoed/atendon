import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import type { EmailProvider } from "../src/mail/email-provider.js";
import { buildInvitationAcceptUrl, shouldExposeInvitationToken } from "../src/mail/invitations.js";
import { setEmailProviderForTests } from "../src/mail/index.js";

const fakeConfiguredProvider: EmailProvider = {
  isConfigured: true,
  async send() {}
};

describe("workspace invitation mail helpers", () => {
  afterEach(() => {
    config.NODE_ENV = "test";
    setEmailProviderForTests(undefined);
  });

  it("builds the public invitation URL from the panel base URL", () => {
    const url = buildInvitationAcceptUrl(config, "sample-token");
    expect(url).toContain("/convite");
    expect(url).toContain("token=sample-token");
    expect(url.startsWith(config.PANEL_PUBLIC_URL)).toBe(true);
  });

  it("hides response tokens only in production when an email provider is configured", () => {
    config.NODE_ENV = "production";
    setEmailProviderForTests(fakeConfiguredProvider);
    expect(shouldExposeInvitationToken(config, fakeConfiguredProvider)).toBe(false);

    config.NODE_ENV = "test";
    expect(shouldExposeInvitationToken(config, fakeConfiguredProvider)).toBe(true);
    expect(shouldExposeInvitationToken(config, { isConfigured: false, async send() {} })).toBe(true);
  });
});
