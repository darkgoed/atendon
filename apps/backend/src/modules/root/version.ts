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

const LEGACY_BRAND_SCOPES: Array<{ pattern: RegExp; slug: string }> = [
  { pattern: /\bnewave\b/i, slug: "newave-ia" },
  { pattern: /\b(?:zulu|tripz)\b/i, slug: "tripzturismo-a44ab4" }
];

function brandScopes(text: string): string[] {
  return LEGACY_BRAND_SCOPES.filter(({ pattern }) => pattern.test(text)).map(({ slug }) => slug);
}

export function filterChangelogHistory(history: StoredChangelogItem[], tenantSlug?: string): ChangelogItem[] {
  return history.map((item) => ({
    version: item.version,
    date: item.date,
    changes: (Array.isArray(item.changes) ? item.changes : []).flatMap((change) => {
      const text = typeof change === "string" ? change.trim() : typeof change?.text === "string" ? change.text.trim() : "";
      if (!text) return [];
      const namedScopes = brandScopes(text);
      const declaredScopes = typeof change === "object" && Array.isArray(change.tenant_slugs)
        ? change.tenant_slugs
        : [];
      // O nome explícito da empresa é autoridade mais restritiva que um item
      // incorretamente marcado como global pelo gerador ou por histórico antigo.
      const effectiveScopes = namedScopes.length ? namedScopes : declaredScopes;
      return effectiveScopes.length === 0 || (tenantSlug && effectiveScopes.includes(tenantSlug)) ? [text] : [];
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
