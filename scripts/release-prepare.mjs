#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.RELEASE_ROOT ? path.resolve(process.env.RELEASE_ROOT) : path.resolve(scriptDir, "..");
const env = { ...process.env, CHANGELOG_STRICT_RELEASE: "1" };
const clean = spawnSync("git", ["status", "--porcelain", "--", "."], { cwd: root, env, encoding: "utf8" });
if (clean.status !== 0) throw new Error("release:prepare exige um checkout Git válido");
if (clean.stdout.trim()) throw new Error("release:prepare exige checkout limpo; faça commit do código antes de preparar a release");
const generator = spawnSync(process.execPath, ["--env-file-if-exists=.env", path.join("scripts", "changelog-bump.mjs")], { cwd: root, env, encoding: "utf8" });
if (generator.status !== 0) throw new Error(generator.stderr || "gerador de changelog falhou em release estrito");
process.stdout.write(generator.stdout);
const sync = spawnSync(process.execPath, [path.join("scripts", "sync-package-lock-version.mjs")], { cwd: root, env, encoding: "utf8" });
if (sync.status !== 0) throw new Error(sync.stderr || "sincronização do package-lock falhou");
process.stdout.write(sync.stdout);
