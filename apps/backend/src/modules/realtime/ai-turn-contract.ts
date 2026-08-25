import { z } from "zod";

export const AI_TURN_PROGRESS_TTL_MS = 30 * 60_000;
export const AI_TURN_PREVIEW_MAX_CHARACTERS = 12_000;

export const aiTurnPhaseSchema = z.enum([
  "reading",
  "analyzing_media",
  "generating",
  "using_tool",
  "preview",
  "sending",
  "cleared"
]);

export type AiTurnPhase = z.infer<typeof aiTurnPhaseSchema>;

export const aiTurnProgressSchema = z.object({
  type: z.literal("conversation.ai.progress"),
  conversationId: z.string(),
  turnId: z.string(),
  attempt: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  phase: aiTurnPhaseSchema,
  label: z.string().max(160).optional(),
  preview: z.string().max(AI_TURN_PREVIEW_MAX_CHARACTERS).optional(),
  previewTruncated: z.boolean().optional(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).strict();

export type AiTurnProgress = z.infer<typeof aiTurnProgressSchema>;

const SAFE_TOOL_LABELS: Readonly<Record<string, string>> = {
  consultar_agendas: "Verificando agendas…",
  consultar_unidades: "Verificando unidades…",
  verificar_horarios: "Verificando horários…",
  verificar_horarios_reuniao: "Verificando horários…",
  agendar_visita: "Atualizando o atendimento…",
  agendar_reuniao: "Atualizando o atendimento…",
  reagendar_visita: "Atualizando o atendimento…",
  reagendar_reuniao: "Atualizando o atendimento…",
  cancelar_visita: "Atualizando o atendimento…",
  cancelar_reuniao: "Atualizando o atendimento…",
  registrar_lead: "Atualizando o atendimento…",
  qualificar_lead: "Atualizando o atendimento…",
  atualizar_status_lead: "Atualizando o atendimento…",
  consultar_categorias: "Consultando informações…",
  consultar_parceiros: "Consultando informações…",
  pesquisar_modelo: "Consultando informações…",
  pesquisar_contexto: "Consultando informações…",
  enviar_proposta_parceiro: "Preparando informações…"
};

export function safeAiToolLabel(toolName: string): string {
  return SAFE_TOOL_LABELS[toolName] ?? "Consultando informações…";
}

export function buildAiTurnPreview(bubbles: readonly string[]): {
  preview: string;
  previewTruncated: boolean;
} {
  const joined = bubbles.map((bubble) => bubble.trim()).filter(Boolean).join("\n\n");
  if (joined.length <= AI_TURN_PREVIEW_MAX_CHARACTERS) {
    return { preview: joined, previewTruncated: false };
  }
  return {
    preview: joined.slice(0, AI_TURN_PREVIEW_MAX_CHARACTERS),
    previewTruncated: true
  };
}
