#!/usr/bin/env node
// Runs on the ops host (via npm run release:prepare), never inside a
// Dockerfile/Coolify build. Computes the technical release (version, build,
// classification, diff metrics) from git and persists it to the `releases`
// table. Deliberately does NOT call any AI here: the public changelog is
// generated afterwards, out of the deploy's critical path, by the backend
// worker (see apps/backend/src/modules/release/reconciler.ts). A missing/
// unreachable database or git failure here must fail the release loudly —
// there is no changelog.json fallback anymore.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const ROOT_DIR = path.resolve(fileURLToPath(import.meta.url), "../..");
const PACKAGE_JSON = path.join(ROOT_DIR, "package.json");
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const DIFF_EXCLUDES = [":!changelog.json", ":!package.json", ":!package-lock.json", ":!**/package-lock.json"];
const CLASSIFICATIONS = new Set(["PATCH", "DROP", "RELEASE"]);
const BASE_COMMIT_LOOKUP_LIMIT = 30;

function git(args) {
  return execFileSync("git", args, { cwd: ROOT_DIR, encoding: "utf8", maxBuffer: 200 * 1024 * 1024 }).trim();
}

// Paths whose changes carry no product-facing signal: lockfiles, build
// output, generated reports/graphs, logs and local state. Extending this
// list is the correct way to exclude a new generated path — never by tuning
// byte thresholds, which was the mechanism this replaces.
const IGNORED_PATH_PATTERNS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)\.next\//,
  /\.tsbuildinfo$/,
  /(^|\/)\.deploy-state\//,
  /(^|\/)graphify-out\//,
  /(^|\/)\.graphify/,
  /(^|\/)coverage\//,
  /(^|\/)playwright-report\//,
  /(^|\/)test-results\//,
  /(^|\/)logs\//,
  /(^|\/)data\//,
  /(^|\/)changelog\.json$/,
  /^package\.json$/,
  /qa-corrected-baseline\//,
  /ui-responsive-audit\.json$/
];

export function isIgnoredDiffPath(filePath) {
  return IGNORED_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
}

export function effectiveDiffFiles(files) {
  return files.filter((file) => !isIgnoredDiffPath(file.path));
}

const MIGRATION_PATH = /^apps\/backend\/src\/db\/migrations\/.*\.sql$/;
const BREAKING_MIGRATION_SQL = /\b(DROP\s+TABLE|DROP\s+COLUMN|ALTER\s+COLUMN\s+\S+\s+TYPE)\b/i;
const NEW_MODULE_PATH = /^apps\/backend\/src\/modules\/([^/]+)\/.*$/;
const NEW_PANEL_AREA_PATH = /^apps\/panel\/app\/([^/]+)\/.*$/;
const NEW_PAGE_PATH = /^apps\/panel\/app\/.*\/page\.tsx$/;
const NEW_ROUTES_PATH = /^apps\/backend\/src\/modules\/[^/]+\/routes\.ts$/;
const BREAKING_COMMIT_MARKER = /\bBREAKING[ _-]?CHANGE\b|^breaking:/im;

function statusOf(file) {
  if (file.status === "A") return "added";
  if (file.status === "M") return "modified";
  if (file.status === "D") return "deleted";
  return "other";
}

// Impact-based classification: PATCH/DROP/RELEASE from what the diff actually
// touches (new modules/routes/pages, breaking migrations, breaking commits),
// never from raw byte size.
export function classifyRelease(files, commitMessages, migrationDiffText = "") {
  const effective = effectiveDiffFiles(files);
  if (effective.length === 0) {
    return { classification: "PATCH", reason: "Nenhuma mudança com impacto de produto detectada" };
  }

  const breakingCommit = commitMessages.some((message) => BREAKING_COMMIT_MARKER.test(message));
  const breakingMigration = effective.some((file) => MIGRATION_PATH.test(file.path))
    && BREAKING_MIGRATION_SQL.test(migrationDiffText);

  const addedAreaCandidates = new Set(
    effective
      .filter((file) => statusOf(file) === "added")
      .map((file) => file.path.match(NEW_MODULE_PATH)?.[1] ?? file.path.match(NEW_PANEL_AREA_PATH)?.[1])
      .filter(Boolean)
  );
  const newModuleCount = [...addedAreaCandidates].filter((name) => {
    const filesInArea = effective.filter((file) => (
      file.path.match(NEW_MODULE_PATH)?.[1] === name || file.path.match(NEW_PANEL_AREA_PATH)?.[1] === name
    ));
    return filesInArea.length > 0 && filesInArea.every((file) => statusOf(file) === "added");
  }).length;

  if (breakingCommit || breakingMigration || newModuleCount > 0) {
    const reason = breakingCommit
      ? "Commit sinaliza BREAKING CHANGE"
      : breakingMigration
        ? "Migration remove/altera estrutura existente (DROP/ALTER destrutivo)"
        : `Novo(s) módulo(s) adicionado(s): ${[...addedAreaCandidates].join(", ")}`;
    return { classification: "RELEASE", reason };
  }

  const newRoutes = effective.some((file) => NEW_ROUTES_PATH.test(file.path) && statusOf(file) === "added");
  const newPages = effective.some((file) => NEW_PAGE_PATH.test(file.path) && statusOf(file) === "added");
  const additiveMigration = effective.some((file) => MIGRATION_PATH.test(file.path));
  const distinctAreasTouched = new Set(
    effective.map((file) => file.path.match(NEW_MODULE_PATH)?.[1] ?? file.path.match(NEW_PANEL_AREA_PATH)?.[1]).filter(Boolean)
  ).size;
  const netGrowth = effective.reduce((sum, file) => sum + file.additions - file.deletions, 0) > 0;

  if (newRoutes || newPages || additiveMigration || (distinctAreasTouched >= 3 && netGrowth)) {
    const reason = newRoutes
      ? "Nova(s) rota(s) de API adicionada(s)"
      : newPages
        ? "Nova(s) página(s) de painel adicionada(s)"
        : additiveMigration
          ? "Nova migration aditiva (sem remoção estrutural)"
          : "Mudança distribuída em múltiplos módulos com crescimento líquido de código";
    return { classification: "DROP", reason };
  }

  return {
    classification: "PATCH",
    reason: `Mudança contida em ${effective.length} arquivo(s), sem novo módulo/rota/página`
  };
}

export function bumpVersion(current, classification) {
  const [major, minor, patch] = current.split(".").map(Number);
  if (classification === "RELEASE") return `${major + 1}.0.0`;
  if (classification === "DROP") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function resolveClassificationOverride(env = process.env) {
  const explicit = env.RELEASE_CLASSIFICATION_OVERRIDE?.trim().toUpperCase();
  if (explicit) {
    if (!CLASSIFICATIONS.has(explicit)) throw new Error("RELEASE_CLASSIFICATION_OVERRIDE deve ser PATCH, DROP ou RELEASE");
    return explicit;
  }
  // Backward-compatible with the old byte-size override name/values.
  const legacy = env.VERSION_BUMP?.trim().toLowerCase();
  if (!legacy) return undefined;
  const map = { patch: "PATCH", minor: "DROP", major: "RELEASE" };
  if (!map[legacy]) throw new Error("VERSION_BUMP deve ser patch, minor ou major");
  return map[legacy];
}

function parseNumstat(numstat) {
  if (!numstat) return [];
  return numstat.split("\n").filter(Boolean).map((line) => {
    const [additionsRaw, deletionsRaw, filePath] = line.split("\t");
    return {
      path: filePath,
      status: "M",
      additions: additionsRaw === "-" ? 0 : Number(additionsRaw),
      deletions: deletionsRaw === "-" ? 0 : Number(deletionsRaw)
    };
  });
}

function parseNameStatus(nameStatus) {
  const statuses = new Map();
  if (!nameStatus) return statuses;
  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const [statusCode, ...pathParts] = line.split("\t");
    statuses.set(pathParts.at(-1) ?? "", statusCode.charAt(0));
  }
  return statuses;
}

function isAncestor(commit, headSha) {
  try {
    git(["merge-base", "--is-ancestor", commit, headSha]);
    return true;
  } catch {
    return false;
  }
}

// A release's recorded commit_sha may not be an ancestor of HEAD (shallow
// clone, or history rewritten by a graft/subtree publish). Walk the recent
// ledger for the newest commit that IS an ancestor before giving up to
// HEAD~1 — the same rescue `scripts/changelog-bump.mjs` used to apply.
export function resolveDiffBaseCommit(candidateCommits, headSha, deps = {}) {
  const checkAncestor = deps.isAncestor || isAncestor;
  const log = deps.log || ((message) => console.log(message));
  for (const commit of candidateCommits) {
    if (commit && commit !== "unknown" && checkAncestor(commit, headSha)) return commit;
  }
  if (candidateCommits.length > 0) {
    log("==> Nenhum commit anterior é ancestral do HEAD atual (shallow clone/histórico reescrito); usando HEAD~1");
  }
  const rescue = deps.rescueHeadMinusOne || (() => {
    try { return git(["rev-parse", "HEAD~1"]); } catch { return EMPTY_TREE_SHA; }
  });
  return rescue();
}

export function extractCandidateSlugs(diffText) {
  return new Set(String(diffText).match(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g) || []);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL é obrigatória para registrar a release");
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const headSha = git(["rev-parse", "HEAD"]);
    const branch = process.env.RELEASE_BRANCH?.trim() || (() => {
      try { return git(["rev-parse", "--abbrev-ref", "HEAD"]); } catch { return "main"; }
    })();

    const recentReleases = await client.query(
      `SELECT commit_sha FROM releases WHERE commit_sha <> 'unknown' ORDER BY build_number DESC LIMIT $1`,
      [BASE_COMMIT_LOOKUP_LIMIT]
    );
    const baseCommit = recentReleases.rows.length > 0
      ? resolveDiffBaseCommit(recentReleases.rows.map((row) => row.commit_sha), headSha)
      : EMPTY_TREE_SHA;

    const diffStat = git(["diff", "--stat", `${baseCommit}..${headSha}`, "--", ".", ...DIFF_EXCLUDES]);
    if (!diffStat) {
      console.log("==> Nenhuma mudança de código desde a última versão; release não registrada");
      return;
    }
    const numstat = git(["diff", "--numstat", `${baseCommit}..${headSha}`, "--", ".", ...DIFF_EXCLUDES]);
    const nameStatus = git(["diff", "--name-status", `${baseCommit}..${headSha}`, "--", ".", ...DIFF_EXCLUDES]);
    const statuses = parseNameStatus(nameStatus);
    const files = parseNumstat(numstat).map((file) => ({ ...file, status: statuses.get(file.path) ?? file.status }));
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    const commitMessages = (() => {
      try {
        const log = git(["log", "--format=%s", `${baseCommit}..${headSha}`]);
        return log ? log.split("\n").filter(Boolean) : [];
      } catch { return []; }
    })();
    const migrationDiffText = files.some((file) => MIGRATION_PATH.test(file.path))
      ? git(["diff", `${baseCommit}..${headSha}`, "--", "apps/backend/src/db/migrations"])
      : "";

    const override = resolveClassificationOverride();
    const auto = classifyRelease(files, commitMessages, migrationDiffText);
    const classification = override ?? auto.classification;
    const classificationReason = override ? `Override manual (${override})` : auto.reason;
    const bumpSource = override ? "manual_override" : "auto";

    const lastVersion = await client.query("SELECT version FROM releases ORDER BY build_number DESC LIMIT 1");
    const baseVersion = lastVersion.rows[0]?.version ?? pkg.version ?? "0.0.0";
    const newVersion = bumpVersion(baseVersion, classification);

    const candidateSlugs = [...extractCandidateSlugs(`${diffStat}\n${nameStatus}`)];
    const knownTenants = candidateSlugs.length > 0
      ? (await client.query("SELECT slug FROM tenants WHERE slug = ANY($1::text[])", [candidateSlugs])).rows.map((row) => row.slug)
      : [];

    const effective = effectiveDiffFiles(files);
    const modulesAffected = [...new Set(
      effective.map((file) => file.path.match(NEW_MODULE_PATH)?.[1] ?? file.path.match(NEW_PANEL_AREA_PATH)?.[1]).filter(Boolean)
    )];
    const diffExcerpt = git(["diff", `${baseCommit}..${headSha}`, "--", ".", ...DIFF_EXCLUDES]).slice(0, 15000);

    const inserted = await client.query(
      `INSERT INTO releases(
         version,classification,classification_reason,bump_source,commit_sha,branch,
         additions,deletions,files_changed,modules_affected,scope,tenant_slugs_detected,
         commit_messages,diff_excerpt,technical_changelog,ai_status,created_by
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'GLOBAL',$11,$12,$13,$14,'pending','release-prepare')
       RETURNING build_number`,
      [
        newVersion, classification, classificationReason, bumpSource, headSha, branch,
        additions, deletions, JSON.stringify(files), modulesAffected, knownTenants,
        commitMessages, diffExcerpt,
        `Release ${newVersion} (${classification}): ${classificationReason}. +${additions}/-${deletions} em ${effective.length} arquivo(s) efetivos.`
      ]
    );

    pkg.version = newVersion;
    writeFileSync(PACKAGE_JSON, `${JSON.stringify(pkg, null, 2)}\n`);

    console.log(`==> Build #${inserted.rows[0].build_number} · versão ${newVersion} · ${classification} (${classificationReason})`);
    console.log(`==> +${additions}/-${deletions} em ${effective.length} arquivo(s) efetivos, base ${baseCommit.slice(0, 12)}..${headSha.slice(0, 12)}`);
  } finally {
    await client.end();
  }
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error) => {
    console.error(`==> release-record falhou: ${error.message}`);
    process.exit(1);
  });
}
