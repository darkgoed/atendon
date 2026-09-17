import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { config } from "../../config.js";
import { db } from "../../db/client.js";

export interface ChangelogItem {
  version: string;
  date: string;
  changes: string[];
}

type ScopedChange = { text: string; tenant_slugs: string[] };

export interface VersionInfo {
  version: string;
  deployVersion: string;
  buildNumber: number | null;
  changelog: ChangelogItem[];
}

interface PublishedReleaseRow {
  version: string;
  created_at: Date | string;
  public_changes: ScopedChange[] | null;
}

/** Same visibility rule the legacy changelog.json used: an item with no
 * tenant_slugs is global and shown to everyone; otherwise only to the tenants
 * it names. ROOT-only row-level GLOBAL/TENANT scoping (releases.scope) is a
 * separate concern for the /versions admin module, not this public payload. */
export function filterPublishedReleases(rows: PublishedReleaseRow[], tenantSlug?: string): ChangelogItem[] {
  return rows.map((row) => ({
    version: row.version,
    date: new Date(row.created_at).toISOString().slice(0, 10),
    changes: (row.public_changes ?? []).flatMap((change) => {
      const text = change?.text?.trim();
      if (!text) return [];
      const declaredScopes = Array.isArray(change.tenant_slugs) ? change.tenant_slugs : [];
      return declaredScopes.length === 0 || (tenantSlug && declaredScopes.includes(tenantSlug)) ? [text] : [];
    })
  })).filter((item) => item.changes.length > 0);
}

export async function getVersionInfo(
  tenantSlug?: string,
  database: Pick<Pool, "query"> = db
): Promise<VersionInfo> {
  let releasesCurrent: string | undefined;
  let buildNumber: number | null = null;
  let changelog: ChangelogItem[] = [];

  try {
    const latest = await database.query<{ version: string; build_number: string }>(
      "SELECT version,build_number FROM releases ORDER BY build_number DESC LIMIT 1"
    );
    releasesCurrent = latest.rows[0]?.version;
    if (latest.rows[0]?.build_number) buildNumber = Number(latest.rows[0].build_number);

    const published = await database.query<PublishedReleaseRow>(
      `SELECT version,created_at,public_changes FROM releases
       WHERE published=true
       ORDER BY build_number DESC
       LIMIT 20`
    );
    changelog = filterPublishedReleases(published.rows, tenantSlug);
  } catch (error) {
    console.warn("Não foi possível ler o histórico de releases; usando fallback de versão", error);
  }

  let packageVersion = "0.0.0";
  try {
    const packageRaw = await readFile(fileURLToPath(new URL("../../../../../package.json", import.meta.url)), "utf-8");
    const parsedPackage = JSON.parse(packageRaw) as { version?: string };
    if (typeof parsedPackage.version === "string" && parsedPackage.version.trim()) packageVersion = parsedPackage.version.trim();
  } catch (error) {
    console.warn("Não foi possível ler package.json para fallback de versão", error);
  }
  const currentVersion = config.APP_VERSION?.trim() || releasesCurrent || packageVersion;

  return {
    version: currentVersion,
    deployVersion: config.DEPLOY_VERSION,
    buildNumber,
    changelog
  };
}
