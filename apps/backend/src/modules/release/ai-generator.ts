import { postOpenRouterChatCompletions } from "../ai-router/openrouter-http.js";
import type { ScopedChange } from "./repository.js";

const DIFF_MAX_CHARS = 15000;
const GENERIC_CHANGE: ScopedChange = { text: "Melhorias internas e correções de estabilidade", tenant_slugs: [] };

const CHANGELOG_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120 },
    summary: { type: "string", minLength: 1, maxLength: 400 },
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
  required: ["title", "summary", "changes"],
  additionalProperties: false
};

export function sanitizeDiffForAi(diffText: string): string {
  return diffText
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]")
    .replace(/\b(?:\+?\d[\d ().-]{7,}\d)\b/g, "[phone redacted]")
    .replace(/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1[credentials redacted]@")
    .replace(/(authorization\s*:\s*(?:bearer\s+)?)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|sk-or-v1-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "[token redacted]");
}

export interface AiChangelogResult {
  title: string;
  summary: string;
  changes: ScopedChange[];
}

export function parseAiChangelogResponse(content: string | null | undefined, allowedSlugs: Set<string>): AiChangelogResult {
  if (typeof content !== "string" || !content.trim()) throw new Error("OpenRouter retornou conteúdo vazio");
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content) as {
    title?: unknown; summary?: unknown; changes?: unknown;
  };
  if (typeof parsed.title !== "string" || !parsed.title.trim()) throw new Error("OpenRouter retornou title inválido");
  if (typeof parsed.summary !== "string" || !parsed.summary.trim()) throw new Error("OpenRouter retornou summary inválido");
  if (!Array.isArray(parsed.changes)) throw new Error("OpenRouter retornou changes inválido");

  const changes: ScopedChange[] = parsed.changes
    .filter((change): change is Record<string, unknown> => Boolean(change) && typeof change === "object" && !Array.isArray(change))
    .map((change) => {
      const text = typeof change.text === "string" ? change.text.trim() : "";
      const declaredScopes = Array.isArray(change.tenant_slugs) ? change.tenant_slugs : [];
      const hadScope = declaredScopes.length > 0;
      const tenantSlugs = [...new Set(
        declaredScopes.filter((slug): slug is string => typeof slug === "string" && allowedSlugs.has(slug))
      )];
      return { text, tenant_slugs: tenantSlugs, hadScope };
    })
    .filter((change) => change.text && (!change.hadScope || change.tenant_slugs.length > 0))
    .map((change) => ({ text: change.text, tenant_slugs: change.tenant_slugs }))
    .slice(0, 6);
  if (changes.length === 0) throw new Error("OpenRouter não retornou itens de changelog");

  return { title: parsed.title.trim(), summary: parsed.summary.trim(), changes };
}

export function extractCandidateSlugs(diffText: string): Set<string> {
  return new Set(diffText.match(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g) ?? []);
}

interface OpenRouterErrorBody { error?: { message?: string } }

async function readOpenRouterError(response: Response): Promise<string> {
  try {
    const body = await response.json() as OpenRouterErrorBody;
    const message = typeof body?.error?.message === "string" ? body.error.message.trim() : "";
    return message.replace(/sk-or-v1-[A-Za-z0-9]+/g, "[chave omitida]").replace(/\s+/g, " ").slice(0, 500);
  } catch {
    return "";
  }
}

export interface GenerateChangelogInput {
  diffStat: string;
  diffText: string;
  commitMessages: string[];
  /** Slugs comprovado pelo diff (tenant_slugs_detected da release). A IA só
   * pode atribuir escopo a slugs presentes nesta lista. */
  knownTenantSlugs: string[];
  apiKey: string;
  primaryModel: string;
  fallbackModel: string | null;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface GenerateChangelogOutput extends AiChangelogResult {
  modelUsed: string;
}

const SYSTEM_PROMPT = "Você resume um release técnico do AtendON para o changelog público em português do Brasil. Gere um título curto (até 8 palavras), um resumo de 1-2 frases, e de 1 a 6 itens descrevendo somente mudanças perceptíveis por quem usa o produto. Cada item tem text e tenant_slugs. Use tenant_slugs=[] apenas para segurança, estabilidade ou recursos realmente compartilhados por todas as empresas. Mudanças em prompt, IA, regras, integrações ou comportamento de uma empresa específica devem listar somente os slugs exatos fornecidos na lista de slugs conhecidos. Nunca cite nome de empresa como mudança global; se o slug não puder ser comprovado, omita o item. Não mencione changelog, commits, arquivos, testes, refactors, lint, infraestrutura ou detalhes internos. Não invente funcionalidades. Se não houver efeito perceptível, use um único item global genérico sobre estabilidade. Retorne somente JSON válido no formato exato {\"title\":\"...\",\"summary\":\"...\",\"changes\":[{\"text\":\"item curto\",\"tenant_slugs\":[]}]}, sem outros campos ou texto fora do JSON.";

/** No retry loop against the AI provider by design: this call runs outside
 * the deploy's critical path (see modules/release/pipeline.ts), so a caller
 * (the retry reconciler) re-invokes this function on its own schedule instead
 * of blocking here. Tries primaryModel once, then fallbackModel once if set. */
export async function generateChangelogWithAi(input: GenerateChangelogInput): Promise<GenerateChangelogOutput> {
  const baseUrl = input.baseUrl ?? "https://openrouter.ai/api/v1";
  const timeoutMs = input.timeoutMs ?? 120000;
  const fetcher = input.fetchImpl ?? globalThis.fetch;
  const sanitizedDiff = sanitizeDiffForAi(input.diffText);
  const truncatedDiff = sanitizedDiff.length > DIFF_MAX_CHARS
    ? `${sanitizedDiff.slice(0, DIFF_MAX_CHARS)}\n... (diff truncado)`
    : sanitizedDiff;
  const allowedSlugs = new Set(input.knownTenantSlugs);
  const commitSummary = input.commitMessages.length > 0
    ? `Commits:\n${input.commitMessages.slice(0, 30).join("\n")}\n\n`
    : "";
  const userContent = `${commitSummary}Resumo estatístico:\n${input.diffStat}\n\nSlugs de empresas conhecidos neste diff: ${[...allowedSlugs].join(", ") || "(nenhum)"}\n\nDiff:\n${truncatedDiff}`;

  const models = [input.primaryModel, ...(input.fallbackModel ? [input.fallbackModel] : [])];
  let lastError: Error | undefined;
  for (const model of models) {
    try {
      const response = await postOpenRouterChatCompletions({
        baseUrl,
        apiKey: input.apiKey,
        timeoutMs,
        fetcher,
        body: {
          model,
          max_tokens: 1400,
          temperature: 0.2,
          response_format: { type: "json_schema", json_schema: { name: "changelog", strict: true, schema: CHANGELOG_SCHEMA } },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent }
          ]
        }
      });
      if (!response.ok) {
        const detail = await readOpenRouterError(response);
        throw new Error(`OpenRouter respondeu ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      const body = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
      const result = parseAiChangelogResponse(body.choices?.[0]?.message?.content, allowedSlugs);
      return { ...result, modelUsed: model };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("Falha desconhecida ao gerar changelog com IA");
}

export { GENERIC_CHANGE };
