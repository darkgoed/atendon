#!/usr/bin/env node
// Ops-host entry point (npm run release:prepare): requires a clean checkout,
// records the technical release (version/build/classification) in the
// `releases` table via release-record.mjs, then syncs package-lock.json's
// version field. Never calls the changelog AI — that happens later, out of
// the deploy's critical path, driven by the backend worker's reconciler.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.RELEASE_ROOT ? path.resolve(process.env.RELEASE_ROOT) : path.resolve(scriptDir, "..");
const env = { ...process.env };
const clean = spawnSync("git", ["status", "--porcelain", "--", "."], { cwd: root, env, encoding: "utf8" });
if (clean.status !== 0) throw new Error("release:prepare exige um checkout Git válido");
if (clean.stdout.trim()) throw new Error("release:prepare exige checkout limpo; faça commit do código antes de preparar a release");

const recorder = spawnSync(process.execPath, ["--env-file-if-exists=.env", path.join("scripts", "release-record.mjs")], { cwd: root, env, encoding: "utf8" });
if (recorder.status !== 0) throw new Error(recorder.stderr || "registro da release falhou");
process.stdout.write(recorder.stdout);

const sync = spawnSync(process.execPath, [path.join("scripts", "sync-package-lock-version.mjs")], { cwd: root, env, encoding: "utf8" });
if (sync.status !== 0) throw new Error(sync.stderr || "sincronização do package-lock falhou");
process.stdout.write(sync.stdout);
