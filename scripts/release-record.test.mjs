import assert from "node:assert/strict";
import test from "node:test";
import { guardMajorBump, bumpVersion, classifyRelease } from "./release-record.mjs";

// O incidente de 2026-09-29: um RELEASE auto-classificado empurrou a versão
// comercial da casa 2.x.x para a 3.x.x. O guard torna o salto de major uma
// decisão explícita do operador (override), nunca um efeito colateral do diff.

test("guardMajorBump bloqueia RELEASE automático", () => {
  assert.throws(() => guardMajorBump("RELEASE", undefined), /RELEASE_CLASSIFICATION_OVERRIDE=RELEASE/);
});

test("guardMajorBump permite RELEASE com override explícito", () => {
  assert.doesNotThrow(() => guardMajorBump("RELEASE", "RELEASE"));
});

test("guardMajorBump permite PATCH e DROP sem override", () => {
  assert.doesNotThrow(() => guardMajorBump("PATCH", undefined));
  assert.doesNotThrow(() => guardMajorBump("DROP", undefined));
  assert.doesNotThrow(() => guardMajorBump("PATCH", "PATCH"));
});

test("bumpVersion: PATCH e DROP permanecem na casa do major atual; só RELEASE salta", () => {
  assert.equal(bumpVersion("2.2.9", "PATCH"), "2.2.10");
  assert.equal(bumpVersion("2.2.9", "DROP"), "2.3.0");
  assert.equal(bumpVersion("2.2.9", "RELEASE"), "3.0.0");
});

test("classifyRelease: BREAKING CHANGE no commit leva a RELEASE — e portanto exige override no guard", () => {
  const files = [{ path: "apps/panel/components/x.tsx", status: "modified", additions: 5, deletions: 1 }];
  const auto = classifyRelease(files, ["feat(atendon): quebra contrato", "BREAKING CHANGE: remove endpoint público"], "");
  assert.equal(auto.classification, "RELEASE");
  assert.throws(() => guardMajorBump(auto.classification, undefined));
});

test("classifyRelease: mudança comum em arquivo existente é PATCH", () => {
  const files = [{ path: "apps/panel/components/dashboard-widgets.tsx", status: "modified", additions: 10, deletions: 4 }];
  const auto = classifyRelease(files, ["fix(atendon): ajuste de rotulo"], "");
  assert.equal(auto.classification, "PATCH");
});
