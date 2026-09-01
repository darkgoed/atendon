import { describe, expect, it } from "vitest";
import { parseAppConfig } from "../src/config.js";

const base = {
  NODE_ENV: "production", DATABASE_URL: "postgresql://atendon_app:secret@db/app", DEPLOY_VERSION: "release-2026-09-01",
  JWT_SECRET: "j".repeat(32), DATA_ENCRYPTION_KEY: "d".repeat(32), PANEL_SEED_PASSWORD: "StrongPassword123",
  EVOLUTION_API_KEY: "e".repeat(32), EVOLUTION_WEBHOOK_SECRET: "w".repeat(32),
  PANEL_ORIGIN: "https://panel.example.com", PANEL_PUBLIC_URL: "https://panel.example.com",
  TRANSFER_NOTIFICATION_WEBHOOK_URL: "https://hooks.example.com/transfer",
  GOOGLE_MEET_TOKEN_URL: "https://oauth2.googleapis.com/token", GOOGLE_MEET_API_BASE_URL: "https://meet.googleapis.com",
  GOOGLE_MEET_OAUTH_AUTH_URL: "https://accounts.google.com/o/oauth2/v2/auth", GOOGLE_MEET_OAUTH_USERINFO_URL: "https://openidconnect.googleapis.com/v1/userinfo",
};

const invalidWebhook = ["http://hooks.example.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.1/x", "https://192.168.1.1/x"];
const google = ["GOOGLE_MEET_TOKEN_URL", "GOOGLE_MEET_API_BASE_URL", "GOOGLE_MEET_OAUTH_AUTH_URL", "GOOGLE_MEET_OAUTH_USERINFO_URL"] as const;

describe("production outbound configuration", () => {
  it.each(invalidWebhook)("rejects unsafe transfer webhook %s", (url) => expect(() => parseAppConfig({ ...base, TRANSFER_NOTIFICATION_WEBHOOK_URL: url })).toThrow());
  it.each(google)("rejects altered %s", (name) => expect(() => parseAppConfig({ ...base, [name]: "https://alternative.example.com" })).toThrow());
  it("accepts alternative endpoints outside production", () => {
    for (const NODE_ENV of ["development", "test"]) {
      expect(() => parseAppConfig({ ...base, NODE_ENV, DEPLOY_VERSION: "development", GOOGLE_MEET_TOKEN_URL: "https://alt.test/token", GOOGLE_MEET_API_BASE_URL: "https://alt.test", GOOGLE_MEET_OAUTH_AUTH_URL: "https://alt.test/auth", GOOGLE_MEET_OAUTH_USERINFO_URL: "https://alt.test/user" })).not.toThrow();
    }
  });
});
