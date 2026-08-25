import { describe, expect, it } from "vitest";
import { LOGGER_REDACTION_PATHS, sanitizeRequestUrl } from "../src/logger.js";

describe("request log URL sanitization", () => {
  it("removes query values and invitation secrets", () => {
    expect(sanitizeRequestUrl("/categorias?tenant=secret&busca=telefone")).toBe("/categorias");
    expect(sanitizeRequestUrl("/invitations/token-super-secreto")).toBe("/invitations/[redacted]");
  });

  it("preserves non-secret request paths", () => {
    expect(sanitizeRequestUrl("/workspaces/current/api-keys/123/rotate")).toBe("/workspaces/current/api-keys/123/rotate");
    expect(sanitizeRequestUrl(undefined)).toBeUndefined();
  });

  it("redacts common provider and authentication secret field names", () => {
    expect(LOGGER_REDACTION_PATHS).toEqual(expect.arrayContaining([
      "req.headers.authorization",
      "req.headers.cookie",
      "*.password",
      "*.token",
      "*.clientSecret",
      "*.refreshToken",
      "*.externalId",
      "*.contactPhone",
      "*.instance"
    ]));
  });
});
