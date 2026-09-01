import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("..", import.meta.url);
const sourceRoot = root.pathname;

test("escopa clean check ao app, ignorando sibling sujo e rejeitando sujeira no app", async () => {
  const dir = await mkdtemp(join(tmpdir(), "release-monorepo-"));
  const app = join(dir, "apps", "atendon");
  try {
    await cp(join(sourceRoot, "scripts"), join(app, "scripts"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    await writeFile(join(app, "package-lock.json"), JSON.stringify({ name: "fixture", version: "0.9.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "0.9.0" } } }));
    await writeFile(join(app, "changelog.json"), JSON.stringify({ current: "1.0.0", history: [] }));
    await writeFile(join(app, ".env"), "VERSION_BUMP=patch\n");
    await writeFile(join(dir, "apps/sibling.txt"), "dirty sibling\n");
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["commit", "-qm", "base"], { cwd: dir });
    await writeFile(join(dir, "apps/sibling.txt"), "dirty sibling\nchanged\n");
    let result = spawnSync(process.execPath, ["scripts/release-prepare.mjs"], { cwd: app, env: { ...process.env, RELEASE_ROOT: app, RELEASE_ALLOW_GENERIC_FALLBACK: "true" }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const lock = JSON.parse(await readFile(join(app, "package-lock.json"), "utf8"));
    assert.equal(lock.version, "1.0.1");
    await writeFile(join(app, "dirty.txt"), "must reject\n");
    result = spawnSync(process.execPath, ["scripts/release-prepare.mjs"], { cwd: app, env: { ...process.env, RELEASE_ROOT: app, RELEASE_ALLOW_GENERIC_FALLBACK: "true" }, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checkout limpo/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("modo release estrito rejeita fallback quando IA configurada", async () => {
  const dir = await mkdtemp(join(tmpdir(), "release-strict-"));
  try {
    await cp(join(sourceRoot, "scripts"), join(dir, "scripts"), { recursive: true });
    await cp(join(sourceRoot, "scripts/release-prepare.mjs"), join(dir, "scripts/release-prepare.mjs"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    await writeFile(join(dir, "package-lock.json"), JSON.stringify({ version: "1.0.0", packages: { "": { version: "1.0.0" } } }));
    await writeFile(join(dir, "changelog.json"), JSON.stringify({ current: "1.0.0", history: [] }));
    await writeFile(join(dir, ".env"), "CHANGELOG_OPENROUTER_API_KEY=configured\nOPENROUTER_BASE_URL=http://127.0.0.1:1\nCHANGELOG_OPENROUTER_MAX_ATTEMPTS=1\n");
    spawnSync("git", ["init", "-q"], { cwd: dir }); spawnSync("git", ["config", "user.email", "t@e"], { cwd: dir }); spawnSync("git", ["config", "user.name", "T"], { cwd: dir }); spawnSync("git", ["add", "."], { cwd: dir }); spawnSync("git", ["commit", "-qm", "base"], { cwd: dir }); await writeFile(join(dir, "feature.txt"), "x");
    spawnSync("git", ["add", "feature.txt"], { cwd: dir }); spawnSync("git", ["commit", "-qm", "feature"], { cwd: dir });
    const result = spawnSync(process.execPath, ["scripts/release-prepare.mjs"], { cwd: dir, env: { ...process.env, RELEASE_ROOT: dir }, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release estrito: OpenRouter falhou|OpenRouter respondeu|fetch failed/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
