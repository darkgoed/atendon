import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import pg from "pg";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { blockingStatusEntries } from "./release-prepare.mjs";

loadEnv({ path: fileURLToPath(new URL("../.env.test", import.meta.url)), quiet: true });

// O diretório do app hospeda estado de sessão de agentes (.hermes/, .claude/,
// comments.md…) que nunca entra numa release e fica permanentemente sujo na
// máquina de operação. Tratá-lo como sujeira travava o release:prepare para
// sempre: nenhuma versão nova era registrada e o changelog congelava.
test("estado de sessão de agentes não bloqueia a release; código sujo bloqueia", () => {
  assert.deepEqual(blockingStatusEntries([
    " M comments.md",
    "?? .hermes/plans/algo.md",
    "?? .claude/skills/x/SKILL.md",
    "?? .agents/skills/y/SKILL.md",
    " M .codex/hooks.json",
    " M skills-lock.json",
    " D .hermes/state/progress.md"
  ].join("\n")), []);

  // O git reporta caminhos relativos à raiz do worktree compartilhado, não ao
  // app: foi exatamente esse prefixo que fez a primeira versão do gate falhar.
  assert.deepEqual(blockingStatusEntries([
    "?? apps/atendon/.hermes/state/progress.md",
    " M apps/atendon/comments.md",
    " M apps/atendon/skills-lock.json"
  ].join("\n")), []);

  assert.deepEqual(
    blockingStatusEntries(" M apps/backend/src/index.ts\n?? .hermes/x.md\n"),
    ["M apps/backend/src/index.ts"]
  );
  // Renomeação: quem manda é o destino.
  assert.deepEqual(blockingStatusEntries("R  .hermes/a.md -> apps/panel/app/page.tsx"), [
    "R  .hermes/a.md -> apps/panel/app/page.tsx"
  ]);
});

const root = new URL("..", import.meta.url);
const sourceRoot = root.pathname;

// release-record.mjs imports "pg". The fixture dirs below are copied to /tmp
// without node_modules, so ESM resolution needs a symlink to the real one.
async function linkNodeModules(dir) {
  await symlink(join(sourceRoot, "node_modules"), join(dir, "node_modules"), "dir");
}

// release-record.mjs only needs `releases` (insert/select) and `tenants(slug)`
// (candidate slug lookup); this minimal fixture schema avoids running the
// full migration set (160+ files) for every test in this file.
const FIXTURE_SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE tenants (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), slug TEXT UNIQUE);
CREATE SEQUENCE releases_build_number_seq;
CREATE TABLE releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  build_number BIGINT NOT NULL DEFAULT nextval('releases_build_number_seq') UNIQUE,
  version TEXT NOT NULL UNIQUE,
  classification TEXT NOT NULL,
  classification_reason TEXT NOT NULL DEFAULT '',
  bump_source TEXT NOT NULL DEFAULT 'auto',
  commit_sha TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  additions INT NOT NULL DEFAULT 0,
  deletions INT NOT NULL DEFAULT 0,
  files_changed JSONB NOT NULL DEFAULT '[]'::jsonb,
  modules_affected TEXT[] NOT NULL DEFAULT '{}',
  scope TEXT NOT NULL DEFAULT 'GLOBAL',
  tenant_slugs_detected TEXT[] NOT NULL DEFAULT '{}',
  commit_messages TEXT[] NOT NULL DEFAULT '{}',
  diff_excerpt TEXT NOT NULL DEFAULT '',
  technical_changelog TEXT NOT NULL DEFAULT '',
  public_title TEXT,
  public_summary TEXT,
  public_changes JSONB NOT NULL DEFAULT '[]'::jsonb,
  ai_status TEXT NOT NULL DEFAULT 'pending',
  ai_error TEXT,
  ai_model_used TEXT,
  ai_attempt_count INT NOT NULL DEFAULT 0,
  ai_last_attempt_at TIMESTAMPTZ,
  published BOOLEAN NOT NULL DEFAULT false,
  published_at TIMESTAMPTZ,
  manual_override BOOLEAN NOT NULL DEFAULT false,
  overridden_by_user_id UUID,
  overridden_at TIMESTAMPTZ,
  is_legacy_import BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT NOT NULL DEFAULT 'deploy-pipeline',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function withFixtureDatabase(run) {
  const adminUrl = new URL(process.env.TEST_DATABASE_URL);
  adminUrl.pathname = "/postgres";
  const databaseName = `atendon_release_prepare_test_${randomUUID().replaceAll("-", "")}`;
  const targetUrl = new URL(process.env.TEST_DATABASE_URL);
  targetUrl.pathname = `/${databaseName}`;
  const admin = new pg.Pool({ connectionString: adminUrl.toString() });
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const client = new pg.Client({ connectionString: targetUrl.toString() });
    await client.connect();
    try {
      await client.query(FIXTURE_SCHEMA);
      await run(targetUrl.toString(), client);
    } finally {
      await client.end();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  }
}

test("escopa clean check ao app, ignorando sibling sujo e rejeitando sujeira no app", async () => {
  const dir = await mkdtemp(join(tmpdir(), "release-monorepo-"));
  const app = join(dir, "apps", "atendon");
  try {
    await cp(join(sourceRoot, "scripts"), join(app, "scripts"), { recursive: true });
    await linkNodeModules(app);
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    await writeFile(join(app, "package-lock.json"), JSON.stringify({ name: "fixture", version: "0.9.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "0.9.0" } } }));
    await writeFile(join(dir, "apps/sibling.txt"), "dirty sibling\n");
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["commit", "-qm", "base"], { cwd: dir });
    await writeFile(join(dir, "apps/sibling.txt"), "dirty sibling\nchanged\n");
    await writeFile(join(app, "src.txt"), "feature\n");
    spawnSync("git", ["add", "src.txt"], { cwd: app });
    spawnSync("git", ["commit", "-qm", "feature"], { cwd: app });

    await withFixtureDatabase(async (databaseUrl) => {
      let result = spawnSync(process.execPath, ["scripts/release-prepare.mjs"], {
        cwd: app,
        env: { ...process.env, RELEASE_ROOT: app, DATABASE_URL: databaseUrl },
        encoding: "utf8"
      });
      assert.equal(result.status, 0, result.stderr);
      const lock = JSON.parse(await readFile(join(app, "package-lock.json"), "utf8"));
      assert.equal(lock.version, "1.0.1");

      await writeFile(join(app, "dirty.txt"), "must reject\n");
      result = spawnSync(process.execPath, ["scripts/release-prepare.mjs"], {
        cwd: app,
        env: { ...process.env, RELEASE_ROOT: app, DATABASE_URL: databaseUrl },
        encoding: "utf8"
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /checkout limpo/);
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("classifica por impacto estrutural, não por tamanho de diff, e persiste a release", async () => {
  const dir = await mkdtemp(join(tmpdir(), "release-classify-"));
  try {
    await cp(join(sourceRoot, "scripts"), join(dir, "scripts"), { recursive: true });
    await linkNodeModules(dir);
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    await writeFile(join(dir, "package-lock.json"), JSON.stringify({ version: "1.0.0", packages: { "": { version: "1.0.0" } } }));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "t@e"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "T"], { cwd: dir });
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["commit", "-qm", "base"], { cwd: dir });

    // A large but contained change (single existing file) must classify PATCH.
    await writeFile(join(dir, "big.txt"), "x\n".repeat(50_000));
    spawnSync("git", ["add", "big.txt"], { cwd: dir });
    spawnSync("git", ["commit", "-qm", "large but contained"], { cwd: dir });

    await withFixtureDatabase(async (databaseUrl, client) => {
      const result = spawnSync(process.execPath, ["scripts/release-record.mjs"], {
        cwd: dir,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        encoding: "utf8"
      });
      assert.equal(result.status, 0, result.stderr);
      const row = (await client.query("SELECT version,classification FROM releases ORDER BY build_number DESC LIMIT 1")).rows[0];
      assert.equal(row.classification, "PATCH");
      assert.equal(row.version, "1.0.1");
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("nova rota de API classifica como DROP mesmo com diff pequeno", async () => {
  const dir = await mkdtemp(join(tmpdir(), "release-drop-"));
  try {
    await cp(join(sourceRoot, "scripts"), join(dir, "scripts"), { recursive: true });
    await linkNodeModules(dir);
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    await writeFile(join(dir, "package-lock.json"), JSON.stringify({ version: "1.0.0", packages: { "": { version: "1.0.0" } } }));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "apps/backend/src/modules/example"), { recursive: true });
    // The module directory must already exist with a tracked file in the base
    // commit; otherwise adding routes.ts would make every file in this area
    // an addition, which classify.ts treats as a brand-new module (RELEASE).
    await writeFile(join(dir, "apps/backend/src/modules/example/service.ts"), "export const service = 1;\n");
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "t@e"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "T"], { cwd: dir });
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["commit", "-qm", "base"], { cwd: dir });
    const baseSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();

    await writeFile(join(dir, "apps/backend/src/modules/example/service.ts"), "export const service = 2;\n");
    await writeFile(join(dir, "apps/backend/src/modules/example/routes.ts"), "export const x = 1;\n");
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["commit", "-qm", "add route"], { cwd: dir });

    await withFixtureDatabase(async (databaseUrl, client) => {
      // Seed a prior release pinned to the base commit so release-record.mjs
      // diffs base..HEAD instead of empty-tree..HEAD (which would make the
      // pre-existing service.ts also look like a brand-new file).
      await client.query(
        "INSERT INTO releases(version,classification,commit_sha) VALUES('1.0.0','RELEASE',$1)",
        [baseSha]
      );
      const result = spawnSync(process.execPath, ["scripts/release-record.mjs"], {
        cwd: dir,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        encoding: "utf8"
      });
      assert.equal(result.status, 0, result.stderr);
      const row = (await client.query("SELECT version,classification FROM releases ORDER BY build_number DESC LIMIT 1")).rows[0];
      assert.equal(row.classification, "DROP");
      assert.equal(row.version, "1.1.0");
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
