import assert from "node:assert/strict";
import test from "node:test";

import {
  bumpVersion,
  parseChangelogResponse,
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
    parseChangelogResponse('```json\n{"changes":[{"text":"  Corrige o login  ","tenant_slugs":[]},{"text":"Melhora a IA Zulu","tenant_slugs":["tripzturismo-a44ab4"]}]}\n```'),
    [
      { text: "Corrige o login", tenant_slugs: [] },
      { text: "Melhora a IA Zulu", tenant_slugs: ["tripzturismo-a44ab4"] }
    ]
  );
  assert.throws(() => parseChangelogResponse('{"changes":[]}'), /não retornou itens/);
  assert.throws(() => parseChangelogResponse(""), /conteúdo vazio/);
});

test("solicita JSON estruturado à IA e devolve os itens gerados", async () => {
  let requestBody;
  const changes = await summarizeDiff("1 file changed", "+ correção", {
    env: {
      CHANGELOG_OPENROUTER_API_KEY: "test-key",
      CHANGELOG_OPENROUTER_TIMEOUT_MS: "1000"
    },
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"changes":[{"text":"Login corrigido","tenant_slugs":[]}]}' } }]
        })
      };
    }
  });

  assert.deepEqual(changes, [{ text: "Login corrigido", tenant_slugs: [] }]);
  assert.equal(requestBody.model, "google/gemma-4-26b-a4b-it:free");
  assert.equal(requestBody.response_format.type, "json_schema");
  assert.equal(requestBody.provider.require_parameters, true);
  assert.match(requestBody.messages[0].content, /formato exato/);
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
