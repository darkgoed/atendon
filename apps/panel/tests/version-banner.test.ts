import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchVersion } from "../lib/api";

afterEach(() => vi.unstubAllGlobals());

describe("version API client", () => {
  it("fetches tenant-scoped version info", async () => {
    const mockVersionInfo = {
      version: "1.0.0",
      changelog: [
        {
          version: "1.0.0",
          date: "2026-07-26",
          changes: ["Sistema de versionamento e changelog"]
        }
      ]
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(mockVersionInfo)));

    const result = await fetchVersion();
    expect(result).toEqual(mockVersionInfo);
    expect(result.version).toBe("1.0.0");
    expect(result.changelog).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/panel/version"), expect.anything());
  });
});
