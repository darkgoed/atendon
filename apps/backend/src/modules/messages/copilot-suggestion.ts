import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { requirePermission } from "../../auth/session.js";
import { conversationScopeCondition, resolveCaseScope } from "../../auth/case-scope.js";
import { config } from "../../config.js";
import { db as sharedDb } from "../../db/client.js";
import { HTTP_RATE_LIMITS } from "../../security/http-rate-limit.js";
import { decryptSecret } from "../ai-router/secret-box.js";
import { OpenRouterClient, type AiRouter } from "../ai-router/openrouter.js";
import { consumeAiInteraction, reconcileAiTurnFromUsageLogs, releaseAiInteractionWithoutUsage } from "../../billing/ai-consumption.js";
import { MessageRepository } from "./repository.js";

const copilotParamsSchema = z.object({ id: z.string().uuid() });

const copilotBodySchema = z.object({
  previous_suggestion: z.string().trim().min(1).max(4_000).optional()
}).strict();

// Rascunho sob demanda: o copiloto nunca envia nada e nunca executa ferramentas.
const SUGGESTION_TASK_PROMPT = [
  "Você está assistindo um atendente humano em tempo real.",
  "Escreva SOMENTE o texto da próxima mensagem para o contato, curta e natural, pronta para o atendente revisar e enviar.",
  "Nunca execute ferramentas, nunca anuncie transferência, não use marcadores internos e não afirme que agendamento, cadastro ou cancelamento foi concluído."
].join(" ");

const previousSuggestionInstruction = (previous: string): string =>
  `O atendente rejeitou a sugestão abaixo. Proponha uma alternativa com abordagem diferente; não repita o texto anterior.\nSugestão anterior: """${previous}"""`;

const REPEATED_SUGGESTION_CORRECTION =
  "A resposta repetiu a sugestão anterior. Reescreva com uma abordagem diferente, mantendo o contexto da conversa.";

const COPILOT_CALL_REASON = "copilot_suggestion";

// Erros acionáveis do gate de billing (SPEC R3): nenhuma negação chega ao provedor.
const COPILOT_BILLING_GUARDS = {
  AI_DISABLED: { status: 409, code: "ai_disabled", error: "IA desativada no plano deste workspace" },
  QUOTA_EXCEEDED: { status: 402, code: "ai_quota_exceeded", error: "Limite de interações de IA do plano atingido" },
  CREDIT_CAP_REACHED: { status: 402, code: "ai_credit_cap_reached", error: "Limite de gastos com IA do workspace atingido" },
  BILLING_UNAVAILABLE: { status: 503, code: "billing_unavailable", error: "Cobrança temporariamente indisponível; tente novamente em instantes" }
} as const;

interface CopilotConversationRow {
  agent_config_version_id: string | null;
  system_prompt: string | null;
  ai_model: string | null;
  model_params: { temperature?: number; max_tokens?: number } | null;
  openrouter_provider: string | null;
  openrouter_api_key_encrypted: string | null;
}

interface CopilotHistoryRow {
  sender: "contact" | "agent" | "human";
  content: string;
  total_count: string;
}

export interface CopilotSuggestionRouteOptions {
  db?: Pool;
  ai?: AiRouter;
  historyMaxCharacters?: number;
}

export function registerCopilotSuggestionRoutes(
  app: FastifyInstance,
  options: CopilotSuggestionRouteOptions = {}
) {
  const database = options.db ?? sharedDb;
  const ai = options.ai ?? new OpenRouterClient(config);
  const repository = new MessageRepository(database);
  const maxCharacters = options.historyMaxCharacters ?? config.AI_HISTORY_MAX_CHARACTERS;
  // ponytail: lock em processo (evita gasto duplicado por duplo clique); se o backend escalar horizontalmente, trocar por advisory lock por conversa.
  const generating = new Set<string>();

  app.post("/conversations/:id/copilot-suggestion", {
    config: { rateLimit: HTTP_RATE_LIMITS.sensitiveWrite }
  }, async (request, reply) => {
    const session = await requirePermission(request, "conversations.reply");
    const { id } = copilotParamsSchema.parse(request.params);
    const body = copilotBodySchema.parse(request.body ?? {});
    const scope = await resolveCaseScope(database, session);
    const conversation = await database.query<CopilotConversationRow>(
      `SELECT a.agent_config_version_id,a.system_prompt,a.ai_model,a.model_params,
              s.openrouter_provider,s.openrouter_api_key_encrypted
       FROM conversations c
       LEFT JOIN tenant_ai_settings s ON s.tenant_id=c.tenant_id
       LEFT JOIN LATERAL (
         SELECT v.id agent_config_version_id,v.system_prompt,v.ai_model,v.model_params
         FROM agent_configs cfg
         JOIN agent_config_versions v
           ON v.id=cfg.active_version_id AND v.tenant_id=cfg.tenant_id
          AND v.agent_config_id=cfg.id AND v.status='active'
         WHERE cfg.tenant_id=c.tenant_id
           AND (cfg.session_id = c.session_id OR cfg.session_id IS NULL)
         ORDER BY (cfg.session_id IS NOT NULL) DESC, cfg.updated_at DESC
         LIMIT 1
       ) a ON true
       WHERE c.id=$1 AND c.tenant_id=$2
         AND (${conversationScopeCondition(scope, "c", "$3")})`,
      [id, session.tenantId, scope.userId]
    );
    const row = conversation.rows[0];
    if (!row) return reply.status(404).send({ error: "Conversa não encontrada" });
    if (!row.agent_config_version_id || !row.system_prompt || !row.ai_model) {
      return reply.status(409).send({ error: "Configure o agente desta conexão antes de usar o copiloto" });
    }
    const apiKey = row.openrouter_api_key_encrypted
      ? decryptSecret(row.openrouter_api_key_encrypted, {
        current: config.DATA_ENCRYPTION_KEY,
        previous: config.DATA_ENCRYPTION_KEY_PREVIOUS ? [config.DATA_ENCRYPTION_KEY_PREVIOUS] : [],
        legacy: [config.JWT_SECRET]
      })
      : undefined;
    if (!apiKey) return reply.status(409).send({ error: "Configure a chave da OpenRouter no painel do agente" });

    // Histórico integral do servidor (sem o CTE de 40 mensagens): conta todas as
    // mensagens textuais e mantém o sufixo mais recente dentro do orçamento de
    // caracteres, sempre incluindo a última mensagem (mesma regra do agente).
    const historyResult = await database.query<CopilotHistoryRow>(
      `WITH all_messages AS MATERIALIZED (
         SELECT id,sender,content,created_at,
                row_number() OVER (ORDER BY created_at DESC,id DESC) AS position,
                sum(char_length(content)) OVER (ORDER BY created_at DESC,id DESC) AS cumulative_characters,
                count(*) OVER () AS total_count
         FROM messages
         WHERE conversation_id=$1 AND NOT (sender='agent' AND media_is_sticker)
       )
       SELECT sender,content,total_count
       FROM all_messages
       WHERE cumulative_characters <= $2 OR position = 1
       ORDER BY created_at ASC,id ASC`,
      [id, maxCharacters]
    );
    const messagesTotal = historyResult.rows[0] ? Number(historyResult.rows[0].total_count) : 0;
    const history = historyResult.rows.map((message) => ({
      role: message.sender === "contact" ? "user" as const : "assistant" as const,
      content: message.content
    }));
    // A última mensagem sempre entra no SQL (position=1); se ela sozinha exceder
    // o orçamento, mantém apenas a parte mais recente e sinaliza explicitamente
    // histórico incompleto (SPEC R3) — a entrada da IA nunca é ilimitada.
    const latest = history.at(-1);
    const latestTruncated = latest !== undefined && latest.content.length > maxCharacters;
    if (latest && latestTruncated) latest.content = latest.content.slice(-maxCharacters);
    const contextComplete = history.length >= messagesTotal && !latestTruncated;

    const previous = body.previous_suggestion?.trim();
    const requestId = randomUUID();
    const modelParams = row.model_params ?? {};
    const lockKey = `${session.tenantId}:${id}`;
    if (generating.has(lockKey)) {
      return reply.status(409).send({ error: "Já existe uma sugestão em geração para esta conversa" });
    }
    generating.add(lockKey);
    try {
      // Gate R3 de billing: reserva a interação ANTES de chamar o provedor e
      // reconcilia o uso real DEPOIS (mesmo padrão de process-message/ai-follow-up).
      // Negar por quota ou indisponibilidade de contabilidade nunca chega ao provedor.
      const consumption = await consumeAiInteraction(session.tenantId, "copilot_suggestion", requestId, { conversationId: id });
      if (!consumption.allowed) {
        const guard = COPILOT_BILLING_GUARDS[consumption.reason ?? "BILLING_UNAVAILABLE"];
        request.log.warn({ event: "ai_interaction_blocked", tenantId: session.tenantId, conversationId: id, purpose: COPILOT_CALL_REASON, reason: guard.code }, "Copilot suggestion blocked by billing gate");
        return reply.status(guard.status).send({ error: guard.error, code: guard.code });
      }
      const completion = await ai.complete({
        model: row.ai_model,
        provider: row.openrouter_provider ?? undefined,
        apiKey,
        systemPrompt: row.system_prompt,
        systemContext: previous
          ? `${SUGGESTION_TASK_PROMPT}\n\n${previousSuggestionInstruction(previous)}`
          : SUGGESTION_TASK_PROMPT,
        temperature: modelParams.temperature ?? 0.4,
        maxTokens: modelParams.max_tokens ?? 512,
        history,
        tools: [],
        validateFinalText: previous
          ? (text) => text.trim() === previous ? REPEATED_SUGGESTION_CORRECTION : undefined
          : undefined,
        onUsage: (usage) => repository.recordAiUsage({
          tenantId: session.tenantId,
          conversationId: id,
          requestId,
          ...usage
        }),
        trace: {
          requestId,
          conversationId: id,
          messageId: id,
          processingAttempt: 1,
          tenantId: session.tenantId,
          reason: COPILOT_CALL_REASON
        }
      });
      void reconcileAiTurnFromUsageLogs(session.tenantId, "copilot_suggestion", requestId).catch(() => {});
      return {
        suggestion: completion.text,
        context_complete: contextComplete,
        messages_used: history.length,
        messages_total: messagesTotal
      };
    } catch (error) {
      const typed = error as Error & { code?: string };
      // Sem texto de conversa/sugestão em logs (invariante da SPEC).
      request.log.warn({
        event: "copilot_suggestion_failed",
        tenantId: session.tenantId,
        conversationId: id,
        code: typed.code
      }, "Copilot suggestion generation failed");
      // Provedor falhou: sem usage_logs a reserva volta imediatamente (a cota
      // não fica presa); com usage_logs a função não faz nada e a reconciliação
      // de cobrança permanece responsável.
      void releaseAiInteractionWithoutUsage(session.tenantId, COPILOT_CALL_REASON, requestId);
      if (/\(429\)/.test(typed.message ?? "")) {
        return reply.status(503).send({
          error: "Provedor de IA com limite de uso; tente novamente em instantes",
          code: "provider_rate_limited"
        });
      }
      return reply.status(502).send({
        error: "Falha ao gerar a sugestão de IA",
        ...(typed.code ? { code: typed.code } : {})
      });
    } finally {
      generating.delete(lockKey);
    }
  });
}
