#!/usr/bin/env node
// Roda no build.sh: bumpa a versão (SemVer) e gera uma entrada de changelog
// resumindo, via IA, o diff de código desde a última versão publicada.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT_DIR = path.resolve(fileURLToPath(import.meta.url), "../..");
const PACKAGE_JSON = path.join(ROOT_DIR, "package.json");
const CHANGELOG_JSON = path.join(ROOT_DIR, "changelog.json");
const DIFF_MAX_CHARS = 15000;
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const DIFF_EXCLUDES = [":!changelog.json", ":!package.json", ":!package-lock.json", ":!**/package-lock.json"];
const DEFAULT_MINOR_MIN_KIB = 100;
const DEFAULT_MAJOR_MIN_KIB = 1024;
const DEFAULT_OPENROUTER_MODEL = "google/gemma-4-26b-a4b-it:free";
const BUMP_TYPES = new Set(["patch", "minor", "major"]);
const GENERIC_CHANGE = "Melhorias internas e correções de estabilidade";
const GENERIC_SCOPED_CHANGE = { text: GENERIC_CHANGE, tenant_slugs: [] };
const CHANGELOG_SCHEMA = {
  type: "object",
  properties: {
    changes: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, maxLength: 240 },
          tenant_slugs: {
            type: "array",
            maxItems: 20,
            items: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }
          }
        },
        required: ["text", "tenant_slugs"],
        additionalProperties: false
      }
    }
  },
  required: ["changes"],
  additionalProperties: false
};

function git(args) {
  return execFileSync("git", args, { cwd: ROOT_DIR, encoding: "utf8", maxBuffer: 200 * 1024 * 1024 }).trim();
}

export function bumpVersion(current, bumpType) {
  const [major, minor, patch] = current.split(".").map(Number);
  if (bumpType === "major") return `${major + 1}.0.0`;
  if (bumpType === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function readPositiveThreshold(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} deve ser um número positivo em KiB`);
  }
  return parsed;
}

export function selectBumpType(diffBytes, env = process.env) {
  if (!Number.isFinite(diffBytes) || diffBytes < 0) {
    throw new Error("O tamanho do diff deve ser um número não negativo de bytes");
  }

  const explicitBump = env.VERSION_BUMP?.trim().toLowerCase();
  if (explicitBump) {
    if (!BUMP_TYPES.has(explicitBump)) {
      throw new Error("VERSION_BUMP deve ser patch, minor ou major");
    }
    return explicitBump;
  }

  const minorMinKiB = readPositiveThreshold(
    env.VERSION_MINOR_MIN_KIB,
    DEFAULT_MINOR_MIN_KIB,
    "VERSION_MINOR_MIN_KIB"
  );
  const majorMinKiB = readPositiveThreshold(
    env.VERSION_MAJOR_MIN_KIB,
    DEFAULT_MAJOR_MIN_KIB,
    "VERSION_MAJOR_MIN_KIB"
  );
  if (majorMinKiB <= minorMinKiB) {
    throw new Error("VERSION_MAJOR_MIN_KIB deve ser maior que VERSION_MINOR_MIN_KIB");
  }

  const diffKiB = diffBytes / 1024;
  if (diffKiB >= majorMinKiB) return "major";
  if (diffKiB >= minorMinKiB) return "minor";
  return "patch";
}

function readPositiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} deve ser um número inteiro positivo`);
  }
  return parsed;
}

export function parseChangelogResponse(content) {
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenRouter retornou conteúdo vazio");
  }
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
  if (!Array.isArray(parsed.changes)) {
    throw new Error("OpenRouter retornou changes inválido");
  }
  const changes = parsed.changes
    .filter((change) => change && typeof change === "object" && !Array.isArray(change))
    .map((change) => ({
      text: typeof change.text === "string" ? change.text.trim() : "",
      tenant_slugs: Array.isArray(change.tenant_slugs)
        ? [...new Set(change.tenant_slugs.filter((slug) => typeof slug === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)))]
        : []
    }))
    .filter((change) => change.text)
    .slice(0, 6);
  if (changes.length === 0) {
    throw new Error("OpenRouter não retornou itens de changelog");
  }
  return changes;
}

function isRetryable(error) {
  return error?.name === "AbortError"
    || error?.retryable === true
    || error instanceof TypeError;
}

async function readOpenRouterError(response) {
  try {
    const body = await response.json();
    const message = typeof body?.error?.message === "string"
      ? body.error.message.trim()
      : "";
    return message
      .replace(/sk-or-v1-[A-Za-z0-9]+/g, "[chave omitida]")
      .replace(/\s+/g, " ")
      .slice(0, 500);
  } catch {
    return "";
  }
}

export async function summarizeDiff(diffStat, diffText, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const log = options.log || ((message) => console.log(message));
  const apiKey = env.CHANGELOG_OPENROUTER_API_KEY;
  if (!apiKey) {
    log("==> CHANGELOG_OPENROUTER_API_KEY ausente; usando entrada genérica");
    return [GENERIC_SCOPED_CHANGE];
  }

  const baseUrl = env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  const model = env.CHANGELOG_OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
  const timeoutMs = readPositiveInteger(env.CHANGELOG_OPENROUTER_TIMEOUT_MS, 120000, "CHANGELOG_OPENROUTER_TIMEOUT_MS");
  const maxAttempts = readPositiveInteger(env.CHANGELOG_OPENROUTER_MAX_ATTEMPTS, 2, "CHANGELOG_OPENROUTER_MAX_ATTEMPTS");

  const truncated = diffText.length > DIFF_MAX_CHARS
    ? `${diffText.slice(0, DIFF_MAX_CHARS)}\n... (diff truncado)`
    : diffText;

  let lastError;
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptsMade = attempt;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          max_tokens: 1200,
          temperature: 0.2,
          provider: { require_parameters: true },
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "changelog",
              strict: true,
              schema: CHANGELOG_SCHEMA
            }
          },
          messages: [
            {
              role: "system",
              content: "Analise o diff e descreva somente mudanças perceptíveis por quem usa o produto. Escreva de 1 a 6 itens curtos em português do Brasil. Cada item deve ter text e tenant_slugs. Use tenant_slugs=[] apenas para segurança, estabilidade ou recursos realmente compartilhados por todas as empresas. Mudanças em prompt, IA, regras, integrações ou comportamento de uma empresa devem listar somente os slugs exatos encontrados no diff. Nunca publique Zulu, Newave ou outro nome de empresa como mudança global; se o slug não puder ser comprovado, omita o item. Não mencione changelog, commits, arquivos, testes, refactors, lint, infraestrutura ou detalhes internos. Não invente mudanças. Se não houver efeito perceptível, use um único item global genérico sobre estabilidade. Retorne somente JSON válido no formato exato {\"changes\":[{\"text\":\"item curto\",\"tenant_slugs\":[]}]}, sem outros campos ou texto fora do JSON."
            },
            {
              role: "user",
              content: `Resumo estatístico:\n${diffStat}\n\nDiff:\n${truncated}`
            }
          ]
        })
      });
      if (!response.ok) {
        const detail = await readOpenRouterError(response);
        const error = new Error(`OpenRouter respondeu ${response.status}${detail ? `: ${detail}` : ""}`);
        error.retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
        throw error;
      }
      const body = await response.json();
      try {
        return parseChangelogResponse(body.choices?.[0]?.message?.content);
      } catch (error) {
        error.retryable = true;
        throw error;
      }
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryable(error)) break;
      log(`==> Tentativa ${attempt}/${maxAttempts} da IA falhou (${error.message}); tentando novamente`);
      await sleep(1000 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  log(`==> Falha ao chamar OpenRouter após ${attemptsMade} tentativa(s) (${lastError?.message}); usando entrada genérica`);
  return [GENERIC_SCOPED_CHANGE];
}

async function main() {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
  const changelog = existsSync(CHANGELOG_JSON)
    ? JSON.parse(readFileSync(CHANGELOG_JSON, "utf8"))
    : { current: pkg.version, history: [] };

  const headSha = git(["rev-parse", "HEAD"]);
  const lastCommit = changelog.history[0]?.commit
    || (() => { try { return git(["rev-parse", "HEAD~1"]); } catch { return EMPTY_TREE_SHA; } })();

  const diffStat = git(["diff", "--stat", `${lastCommit}..${headSha}`, "--", ".", ...DIFF_EXCLUDES]);
  if (!diffStat) {
    console.log("==> Nenhuma mudança de código desde a última versão; changelog não alterado");
    return;
  }
  const diffText = git(["diff", "--binary", `${lastCommit}..${headSha}`, "--", ".", ...DIFF_EXCLUDES]);

  const diffBytes = Buffer.byteLength(diffText, "utf8");
  const diffKiB = diffBytes / 1024;
  const bumpType = selectBumpType(diffBytes);
  const bumpSource = process.env.VERSION_BUMP ? "override VERSION_BUMP" : "tamanho do diff";
  console.log(`==> Diff: ${diffKiB.toFixed(1)} KiB → ${bumpType} (${bumpSource})`);
  const newVersion = bumpVersion(pkg.version, bumpType);
  const changes = await summarizeDiff(diffStat, diffText);

  pkg.version = newVersion;
  writeFileSync(PACKAGE_JSON, `${JSON.stringify(pkg, null, 2)}\n`);

  changelog.current = newVersion;
  changelog.history.unshift({
    version: newVersion,
    date: new Date().toISOString().slice(0, 10),
    changes,
    commit: headSha
  });
  writeFileSync(CHANGELOG_JSON, `${JSON.stringify(changelog, null, 2)}\n`);

  console.log(`==> Versão ${pkg.version} → changelog atualizado com ${changes.length} item(ns)`);
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error(`==> changelog-bump falhou: ${error.message}`);
    process.exit(1);
  });
}
