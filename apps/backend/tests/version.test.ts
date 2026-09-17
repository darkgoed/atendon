import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { filterPublishedReleases, getVersionInfo } from "../src/modules/root/version.js";

function fakeDb(rows: Array<{ version: string; created_at: string; public_changes: unknown }>): Pick<Pool, "query"> {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("ORDER BY build_number DESC LIMIT 1")) {
        return { rows: rows.length > 0 ? [{ version: rows[0].version }] : [] };
      }
      return { rows };
    })
  } as unknown as Pick<Pool, "query">;
}

describe("version service", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns version and changelog structure backed by the releases table", async () => {
    const database = fakeDb([{ version: "2.0.0", created_at: "2026-09-05T00:00:00Z", public_changes: [{ text: "Item público", tenant_slugs: [] }] }]);
    const info = await getVersionInfo(undefined, database);
    expect(info).toHaveProperty("version");
    expect(info).toHaveProperty("deployVersion");
    expect(info).toHaveProperty("changelog");
    expect(Array.isArray(info.changelog)).toBe(true);
    expect(info.changelog[0]).toEqual({ version: "2.0.0", date: "2026-09-05", changes: ["Item público"] });
  });

  it("keeps branded changes inside their company while retaining global fixes", () => {
    const rows = [{
      version: "2.0.0",
      created_at: "2026-08-20T00:00:00Z",
      public_changes: [
        { text: "Correção global de segurança", tenant_slugs: [] },
        { text: "A IA Zulu agora entende viagens", tenant_slugs: ["tripzturismo-a44ab4"] },
        { text: "Ajuste específico no prompt Newave", tenant_slugs: ["newave-ia"] },
        { text: "Novo fluxo da empresa sem citar o nome", tenant_slugs: ["tripzturismo-a44ab4"] }
      ]
    }];
    expect(filterPublishedReleases(rows)).toEqual([{
      version: "2.0.0",
      date: "2026-08-20",
      changes: ["Correção global de segurança"]
    }]);
    expect(filterPublishedReleases(rows, "tripzturismo-a44ab4")[0]?.changes).toEqual([
      "Correção global de segurança",
      "A IA Zulu agora entende viagens",
      "Novo fluxo da empresa sem citar o nome"
    ]);
    expect(filterPublishedReleases(rows, "newave-ia")[0]?.changes).toEqual([
      "Correção global de segurança",
      "Ajuste específico no prompt Newave"
    ]);
  });

  it("uses the latest release version when APP_VERSION is absent or empty", async () => {
    const original = config.APP_VERSION;
    const database = fakeDb([{ version: "1.21.0", created_at: "2026-01-01T00:00:00Z", public_changes: [] }]);
    try {
      (config as { APP_VERSION?: string }).APP_VERSION = undefined;
      expect((await getVersionInfo(undefined, database)).version).toBe("1.21.0");
      (config as { APP_VERSION?: string }).APP_VERSION = "";
      expect((await getVersionInfo(undefined, database)).version).toBe("1.21.0");
    } finally {
      (config as { APP_VERSION?: string }).APP_VERSION = original;
    }
  });

  it("prefers an explicitly defined APP_VERSION", async () => {
    const original = config.APP_VERSION;
    const database = fakeDb([{ version: "1.21.0", created_at: "2026-01-01T00:00:00Z", public_changes: [] }]);
    try {
      (config as { APP_VERSION?: string }).APP_VERSION = "9.8.7";
      expect((await getVersionInfo(undefined, database)).version).toBe("9.8.7");
    } finally {
      (config as { APP_VERSION?: string }).APP_VERSION = original;
    }
  });

  it("falls back to package.json when the releases table is unreachable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const brokenDatabase = { query: vi.fn(async () => { throw new Error("connection refused"); }) } as unknown as Pick<Pool, "query">;
    const info = await getVersionInfo(undefined, brokenDatabase);
    expect(info.version).toBeTruthy();
    expect(info.changelog).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "Não foi possível ler o histórico de releases; usando fallback de versão",
      expect.anything()
    );
  });
});
