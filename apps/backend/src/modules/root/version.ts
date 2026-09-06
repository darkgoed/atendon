import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";

export interface ChangelogItem {
  version: string;
  date: string;
  changes: string[];
}

type ScopedChange = { text: string; tenant_slugs: string[] };
type StoredChangelogItem = Omit<ChangelogItem, "changes"> & { changes: Array<string | ScopedChange> };

export function filterChangelogHistory(history: StoredChangelogItem[], tenantSlug?: string): ChangelogItem[] {
  return history.map((item) => ({
    version: item.version,
    date: item.date,
    changes: (Array.isArray(item.changes) ? item.changes : []).flatMap((change) => {
      const text = typeof change === "string" ? change.trim() : typeof change?.text === "string" ? change.text.trim() : "";
      if (!text) return [];
      const declaredScopes = typeof change === "object" && Array.isArray(change.tenant_slugs)
        ? change.tenant_slugs
        : [];
      // O escopo é dado explícito do changelog, nunca inferido pelo nome de uma
      // empresa no texto. Inferência por regex exigia editar código a cada
      // tenant novo e transformava marca em lógica de produto.
      return declaredScopes.length === 0 || (tenantSlug && declaredScopes.includes(tenantSlug)) ? [text] : [];
    })
  })).filter((item) => item.changes.length > 0);
}

export interface VersionInfo {
  version: string;
  deployVersion: string;
  changelog: ChangelogItem[];
}

export async function getVersionInfo(tenantSlug?: string): Promise<VersionInfo> {
  let changelogCurrent: string | undefined;
  let changelog: ChangelogItem[] = [];

  try {
    const raw = await readFile(config.CHANGELOG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { current?: string; history?: StoredChangelogItem[] };
    changelogCurrent = typeof parsed.current === "string" && parsed.current.trim() ? parsed.current.trim() : undefined;
    if (Array.isArray(parsed.history)) {
      changelog = filterChangelogHistory(parsed.history, tenantSlug);
    }
  } catch (error) {
    console.warn("Não foi possível ler changelog.json; usando fallback de versão", error);
  }

  let packageVersion = "0.0.0";
  try {
    const packageRaw = await readFile(fileURLToPath(new URL("../../../../../package.json", import.meta.url)), "utf-8");
    const parsedPackage = JSON.parse(packageRaw) as { version?: string };
    if (typeof parsedPackage.version === "string" && parsedPackage.version.trim()) packageVersion = parsedPackage.version.trim();
  } catch (error) {
    console.warn("Não foi possível ler package.json para fallback de versão", error);
  }
  const currentVersion = config.APP_VERSION?.trim() || changelogCurrent || packageVersion;

  return {
    version: currentVersion,
    deployVersion: config.DEPLOY_VERSION,
    changelog
  };
}
