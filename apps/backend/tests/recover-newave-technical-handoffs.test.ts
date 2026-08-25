import { describe, expect, it } from "vitest";
import { parseRecoveryCliOptions } from "../scripts/recover-newave-technical-handoffs.js";

describe("Newave technical handoff recovery CLI", () => {
  it("is dry-run by default and limits recovery to the confirmed cases", () => {
    expect(parseRecoveryCliOptions([
      "--external-message-id=wamid-1",
      "--external-message-id",
      "wamid-2"
    ])).toEqual({ execute: false, externalMessageIds: ["wamid-1", "wamid-2"] });
    expect(parseRecoveryCliOptions(["--external-message-id=wamid-1"]))
      .toEqual({ execute: false, externalMessageIds: ["wamid-1"] });
    expect(() => parseRecoveryCliOptions([])).toThrow(/um ou dois/i);
    expect(() => parseRecoveryCliOptions([
      "--external-message-id=wamid-1",
      "--external-message-id=wamid-2",
      "--external-message-id=wamid-3"
    ])).toThrow(/um ou dois/i);
  });

  it("only enables writes with the explicit execute flag", () => {
    expect(parseRecoveryCliOptions([
      "--execute",
      "--external-message-id=wamid-1",
      "--external-message-id=wamid-2"
    ]).execute).toBe(true);
  });
});
