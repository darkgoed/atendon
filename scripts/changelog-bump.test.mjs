import assert from "node:assert/strict";
import test from "node:test";

import {
  bumpVersion,
  parseChangelogResponse,
  resolveLastCommit,
  sanitizeDiffForAi,
  selectBumpType,
  summarizeDiff
} from "./changelog-bump.mjs";

test("classifica automaticamente o bump pelo tamanho do diff", () => {
  assert.equal(selectBumpType(99 * 1024), "patch");
  assert.equal(selectBumpType(100 * 1024), "minor");
  assert.equal(selectBumpType(1023 * 1024), "minor");
  assert.equal(selectBumpType(1024 * 1024), "major");
});

test("permite configurar os limites em KiB", () => {
  const env = {
    VERSION_MINOR_MIN_KIB: "10",
    VERSION_MAJOR_MIN_KIB: "50"
  };

  assert.equal(selectBumpType(9 * 1024, env), "patch");
  assert.equal(selectBumpType(10 * 1024, env), "minor");
  assert.equal(selectBumpType(50 * 1024, env), "major");
});

test("VERSION_BUMP continua sendo um override explícito", () => {
  assert.equal(selectBumpType(2 * 1024 * 1024, { VERSION_BUMP: "patch" }), "patch");
  assert.equal(selectBumpType(1, { VERSION_BUMP: "minor" }), "minor");
  assert.equal(selectBumpType(1, { VERSION_BUMP: "major" }), "major");
});

test("rejeita configuração inválida", () => {
  assert.throws(
    () => selectBumpType(1, { VERSION_BUMP: "grande" }),
    /patch, minor ou major/
  );
  assert.throws(
    () => selectBumpType(1, {
      VERSION_MINOR_MIN_KIB: "100",
      VERSION_MAJOR_MIN_KIB: "50"
    }),
    /deve ser maior/
  );
});

test("aplica o nível escolhido à versão SemVer", () => {
  assert.equal(bumpVersion("1.0.18", "patch"), "1.0.19");
  assert.equal(bumpVersion("1.0.18", "minor"), "1.1.0");
  assert.equal(bumpVersion("1.0.18", "major"), "2.0.0");
});

test("normaliza a resposta estruturada do changelog", () => {
  assert.deepEqual(
    parseChangelogResponse('```json\n{"changes":[{"text":"  Corrige o login  ","tenant_slugs":[]},{"text":"Melhora a IA Zulu","tenant_slugs":["tripzturismo-a44ab4"]}]}\n```', ["tripzturismo-a44ab4"]),
    [
      { text: "Corrige o login", tenant_slugs: [] },
      { text: "Melhora a IA Zulu", tenant_slugs: ["tripzturismo-a44ab4"] }
    ]
  );
  assert.throws(() => parseChangelogResponse('{"changes":[]}'), /não retornou itens/);
  assert.throws(() => parseChangelogResponse(""), /conteúdo vazio/);
});

test("filtra slugs ao allowlist e omite item totalmente inventado", () => {
  assert.deepEqual(parseChangelogResponse(JSON.stringify({ changes: [
    { text: "real", tenant_slugs: ["acme", "acme", "fake"] },
    { text: "fake", tenant_slugs: ["fake"] },
    { text: "global", tenant_slugs: [] }
  ]}), ["acme"]), [
    { text: "real", tenant_slugs: ["acme"] }, { text: "global", tenant_slugs: [] }
  ]);
});

test("remove PII e segredos do diff antes do envio", () => {
  const safe = sanitizeDiffForAi("owner@example.com +5511999999999 password=super-secret https://u:p@example.com sk-or-v1-THISISASECRET");
  for (const value of ["owner@example.com", "5511999999999", "super-secret", "u:p", "THISISASECRET"]) assert.doesNotMatch(safe, new RegExp(value));
});
test("envia ao fetch somente diff sanitizado, preservando texto inocente", async () => {
  let requestBody;
  const diff = "owner@example.com telefone +5511999999999 password=super-secret token=tok-secret Authorization: Bearer auth-secret https://u:p@example.com\ntexto inocente";
  await summarizeDiff("1 file changed", diff, {
    env: {
      CHANGELOG_OPENROUTER_API_KEY: "test-key",
      CHANGELOG_OPENROUTER_TIMEOUT_MS: "1000"
    },
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"changes":[{"text":"Login corrigido","tenant_slugs":[]}]}' } }] })
      };
    }
  });

  const sentContent = requestBody.messages[1].content;
  assert.match(sentContent, /texto inocente/);
  for (const secret of ["owner@example.com", "5511999999999", "super-secret", "tok-secret", "auth-secret", "u:p"]) {
    assert.doesNotMatch(sentContent, new RegExp(secret.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")));
  }
});

test("preserva o detalhe seguro de erros não retentáveis da OpenRouter", async () => {
  let attempts = 0;
  const logs = [];
  const changes = await summarizeDiff("1 file changed", "+ correção", {
    env: {
      CHANGELOG_OPENROUTER_API_KEY: "test-key",
      CHANGELOG_OPENROUTER_MAX_ATTEMPTS: "2"
    },
    log: (message) => logs.push(message),
    fetchImpl: async () => {
      attempts += 1;
      return {
        ok: false,
        status: 403,
        json: async () => ({
          error: {
            message: "Key limit exceeded para sk-or-v1-segredo"
          }
        })
      };
    }
  });

  assert.equal(attempts, 1);
  assert.deepEqual(changes, [{ text: "Melhorias internas e correções de estabilidade", tenant_slugs: [] }]);
  assert.match(logs.at(-1), /após 1 tentativa/);
  assert.match(logs.at(-1), /Key limit exceeded/);
  assert.doesNotMatch(logs.at(-1), /sk-or-v1-segredo/);
});

test("repete respostas inválidas antes de usar a resposta da IA", async () => {
  let attempts = 0;
  const changes = await summarizeDiff("1 file changed", "+ correção", {
    env: {
      CHANGELOG_OPENROUTER_API_KEY: "test-key",
      CHANGELOG_OPENROUTER_MAX_ATTEMPTS: "2"
    },
    sleep: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: "" } }] })
        };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"changes":[{"text":"Busca mais estável","tenant_slugs":[]}]}' } }]
        })
      };
    }
  });

  assert.equal(attempts, 2);
  assert.deepEqual(changes, [{ text: "Busca mais estável", tenant_slugs: [] }]);
});

test("degrada parâmetros estruturados uma vez quando não há endpoint compatível", async () => {
  const requests = [];
  const changes = await summarizeDiff("1 file changed", "+ correção", {
    env: { CHANGELOG_OPENROUTER_API_KEY: "test-key", CHANGELOG_OPENROUTER_MAX_ATTEMPTS: "1" },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      if (requests.length === 1) return {
        ok: false, status: 404,
        json: async () => ({ error: { message: "No endpoints found that can handle requested parameters" } })
      };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"changes":[{"text":"Compatível","tenant_slugs":[]}]}' } }] }) };
    }
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].provider, { require_parameters: true });
  assert.equal(requests[0].response_format.type, "json_schema");
  assert.equal(requests[1].provider, undefined);
  assert.equal(requests[1].response_format, undefined);
  assert.equal(requests[1].model, requests[0].model);
  assert.deepEqual(changes, [{ text: "Compatível", tenant_slugs: [] }]);
});

test("resposta inválida do fallback ainda falha em release estrito", async () => {
  const requests = [];
  await assert.rejects(() => summarizeDiff("1 file changed", "+ correção", {
    env: { CHANGELOG_OPENROUTER_API_KEY: "test-key", CHANGELOG_STRICT_RELEASE: "1", CHANGELOG_OPENROUTER_MAX_ATTEMPTS: "1" },
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      if (requests.length === 1) return {
        ok: false, status: 400,
        json: async () => ({ error: { message: "No endpoints found that can handle requested parameters" } })
      };
      return { ok: true, json: async () => ({ choices: [{ message: { content: "não é JSON" } }] }) };
    }
  }), /release estrito: OpenRouter falhou/);
  assert.equal(requests.length, 2);
});

test("mantém o formato compatível na 2ª tentativa após degradar uma vez", async () => {
  // Regressão: sem lembrar que já degradou, a 2ª tentativa reenviava o corpo
  // estruturado, recaía no mesmo 404 (não retryable) e abortava o release
  // estrito mesmo com o fallback compatível já comprovadamente funcional.
  const requests = [];
  const changes = await summarizeDiff("1 file changed", "+ correção", {
    env: { CHANGELOG_OPENROUTER_API_KEY: "test-key", CHANGELOG_STRICT_RELEASE: "1", CHANGELOG_OPENROUTER_MAX_ATTEMPTS: "2" },
    sleep: async () => {},
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      if (requests.length === 1) {
        return {
          ok: false, status: 404,
          json: async () => ({ error: { message: "No endpoints found that can handle requested parameters" } })
        };
      }
      if (requests.length === 2) {
        // 1ª tentativa após degradar: resposta inválida força retry.
        return { ok: true, json: async () => ({ choices: [{ message: { content: "" } }] }) };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"changes":[{"text":"Persistiu o fallback","tenant_slugs":[]}]}' } }] }) };
    }
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[1].response_format, undefined, "2ª chamada já deveria pular direto pro formato compatível");
  assert.equal(requests[2].response_format, undefined);
  assert.deepEqual(changes, [{ text: "Persistiu o fallback", tenant_slugs: [] }]);
});

test("resolveLastCommit pula entradas cujo commit não é ancestral do HEAD (graft/subtree)", () => {
  // Regressão: publicar via graft/subtree reescreve o hash do commit em
  // origin/main; se o changelog.json trouxer esse hash reescrito e o
  // checkout local nunca tiver visto esse commit, o diff era calculado
  // contra uma base inexistente e virava o histórico inteiro do projeto.
  const changelog = {
    history: [
      { version: "1.22.0", commit: "commit-reescrito-pelo-graft" },
      { version: "1.21.0", commit: "commit-real-ancestral" },
      { version: "1.20.0", commit: "outro-commit-real" }
    ]
  };
  const checked = [];
  const commit = resolveLastCommit(changelog, "HEAD_SHA", {
    isAncestor: (c) => { checked.push(c); return c === "commit-real-ancestral"; }
  });
  assert.equal(commit, "commit-real-ancestral");
  assert.deepEqual(checked, ["commit-reescrito-pelo-graft", "commit-real-ancestral"]);
});

test("resolveLastCommit cai para HEAD~1 quando nenhum commit do histórico é ancestral", () => {
  const changelog = { history: [{ version: "1.0.0", commit: "commit-orfao" }] };
  const logs = [];
  const commit = resolveLastCommit(changelog, "HEAD_SHA", {
    isAncestor: () => false,
    rescueHeadMinusOne: () => "head-menos-um",
    log: (m) => logs.push(m)
  });
  assert.equal(commit, "head-menos-um");
  assert.match(logs.at(-1), /histórico reescrito.graft/);
});
