import { describe, expect, it } from "vitest";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://atendon:test@localhost:5436/atendon_test";
process.env.PANEL_SEED_PASSWORD ??= "local-test-password";

const { parseAppConfig } = await import("../src/config.js");

describe("Instagram configuration", () => {
  it("accepts the documented default Graph version and rejects malformed values", () => {
    const base = {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://atendon:test@localhost:5436/atendon_test",
      PANEL_SEED_PASSWORD: "local-test-password"
    };
    expect(parseAppConfig(base).INSTAGRAM_GRAPH_VERSION).toBe("v26.0");
    expect(parseAppConfig({ ...base, INSTAGRAM_GRAPH_VERSION: "v123.45" }).INSTAGRAM_GRAPH_VERSION)
      .toBe("v123.45");
    for (const invalid of ["26.0", "v26", "v26x0", "v26\\.0", "v26.0/path"]) {
      expect(() => parseAppConfig({ ...base, INSTAGRAM_GRAPH_VERSION: invalid })).toThrow();
    }
  });
});
