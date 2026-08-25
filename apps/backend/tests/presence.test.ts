import { describe, expect, it } from "vitest";
import { isPresenceScoreOnline } from "../src/modules/realtime/presence.js";

describe("panel presence expiry", () => {
  it("expires after the shared heartbeat deadline", () => {
    expect(isPresenceScoreOnline(45_001, 45_000)).toBe(true);
    expect(isPresenceScoreOnline(45_000, 45_000)).toBe(false);
    expect(isPresenceScoreOnline(null, 45_000)).toBe(false);
  });
});
