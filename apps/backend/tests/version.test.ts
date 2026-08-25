import { describe, expect, it } from "vitest";
import { filterChangelogHistory, getVersionInfo } from "../src/modules/root/version.js";

describe("version service", () => {
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
});
