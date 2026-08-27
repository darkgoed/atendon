import { afterEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { filterChangelogHistory, getVersionInfo } from "../src/modules/root/version.js";

describe("version service", () => {
  afterEach(() => vi.restoreAllMocks());
  it("returns version and changelog structure", async () => {
    const info = await getVersionInfo();
    expect(info).toHaveProperty("version");
    expect(info).toHaveProperty("deployVersion");
    expect(info).toHaveProperty("changelog");
    expect(Array.isArray(info.changelog)).toBe(true);
    if (info.changelog.length > 0) {
      expect(info.changelog[0]).toHaveProperty("version");
      expect(info.changelog[0]).toHaveProperty("date");
      expect(info.changelog[0]).toHaveProperty("changes");
    }
  });

  it("keeps branded changes inside their company while retaining global fixes", () => {
    const history = [{
      version: "2.0.0",
      date: "2026-08-20",
      changes: [
        "Correção global de segurança",
        "A IA Zulu agora entende viagens",
        "Ajuste específico no prompt Newave",
        { text: "Novo fluxo da empresa sem citar o nome", tenant_slugs: ["tripzturismo-a44ab4"] }
      ]
    }];
    expect(filterChangelogHistory(history)).toEqual([{
      version: "2.0.0",
      date: "2026-08-20",
      changes: ["Correção global de segurança"]
    }]);
    expect(filterChangelogHistory(history, "tripzturismo-a44ab4")[0]?.changes).toEqual([
      "Correção global de segurança",
      "A IA Zulu agora entende viagens",
      "Novo fluxo da empresa sem citar o nome"
    ]);
    expect(filterChangelogHistory(history, "newave-ia")[0]?.changes).toEqual([
      "Correção global de segurança",
      "Ajuste específico no prompt Newave"
    ]);
  });

  it("uses changelog.current when APP_VERSION is absent or empty", async () => {
    const original = config.APP_VERSION;
    try {
      (config as { APP_VERSION?: string }).APP_VERSION = undefined;
      expect((await getVersionInfo()).version).toBe("1.21.0");
      (config as { APP_VERSION?: string }).APP_VERSION = "";
      expect((await getVersionInfo()).version).toBe("1.21.0");
    } finally {
      (config as { APP_VERSION?: string }).APP_VERSION = original;
    }
  });

  it("prefers an explicitly defined APP_VERSION", async () => {
    const original = config.APP_VERSION;
    try {
      (config as { APP_VERSION?: string }).APP_VERSION = "9.8.7";
      expect((await getVersionInfo()).version).toBe("9.8.7");
    } finally {
      (config as { APP_VERSION?: string }).APP_VERSION = original;
    }
  });

  it("returns a valid fallback when changelog is missing", async () => {
    const path = join(tmpdir(), `atendon-missing-${Date.now()}.json`);
    const original = config.CHANGELOG_PATH;
    (config as { CHANGELOG_PATH: string }).CHANGELOG_PATH = path;
    try {
      const info = await getVersionInfo();
      expect(info.version).toBe("1.21.0");
      expect(info.changelog).toEqual([]);
    } finally {
      (config as { CHANGELOG_PATH: string }).CHANGELOG_PATH = original;
    }
  });

  it("falls back to package.json and warns when changelog JSON is invalid", async () => {
    const path = join(tmpdir(), `atendon-invalid-${Date.now()}.json`);
    const original = config.CHANGELOG_PATH;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "{ invalid json", "utf8");
    (config as { CHANGELOG_PATH: string }).CHANGELOG_PATH = path;
    try {
      const info = await getVersionInfo();
      expect(info.version).toBe("1.21.0");
      expect(info.changelog).toEqual([]);
      expect(warn).toHaveBeenCalledWith("Não foi possível ler changelog.json; usando fallback de versão", expect.anything());
    } finally {
      (config as { CHANGELOG_PATH: string }).CHANGELOG_PATH = original;
    }
  });
});
