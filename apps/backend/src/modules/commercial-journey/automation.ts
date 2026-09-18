export const AI_AUTOMATION_LEAD_STATUSES = [
  "novo",
  "em_atendimento",
  "aguardando_resposta",
  "qualificado"
] as const;

const AI_AUTOMATION_STATUS_SET = new Set<string>([
  ...AI_AUTOMATION_LEAD_STATUSES,
  // Accepted only while rolling databases forward from the pre-journey model.
  "em_qualificacao",
  "aprovado"
]);

export function leadStatusAllowsAiAutomation(status: string | null | undefined): boolean {
  return status == null || AI_AUTOMATION_STATUS_SET.has(status);
}

export function commercialStateBlocksAiAutomation(input: {
  leadStatus?: string | null;
  recoveryRequired?: boolean | null;
  unresolvedAppointment?: boolean | null;
  overrideActive?: boolean | null;
}): boolean {
  return input.overrideActive !== true && (input.recoveryRequired === true
    || input.unresolvedAppointment === true
    || !leadStatusAllowsAiAutomation(input.leadStatus));
}

type Queryable = {
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
};

export type ConversationAutomationState = {
  found: boolean;
  blocked: boolean;
  leadStatus: string | null;
  recoveryRequired: boolean;
  leadDeleted: boolean;
  unresolvedAppointment: boolean;
  overrideActive: boolean;
};

export async function loadConversationAutomationState(
  client: Queryable,
  tenantId: string,
  conversationId: string
): Promise<ConversationAutomationState> {
  const result = await client.query<{
    lead_status: string | null;
    recovery_required: boolean | null;
    lead_deleted: boolean;
    unresolved_appointment: boolean;
    override_active: boolean;
  }>(
    `SELECT lead.status lead_status,lead.recovery_required,
            -- Lixeira (0171): lead apagado não alimenta a automação. O LATERAL
            -- abaixo só resolve leads vivos; se NENHUM lead vivo casar (por
            -- lead_id ou telefone) mas um lead na lixeira casar, a conversa
            -- pertence a um contato removido e fica bloqueada.
            lead.id IS NULL
              AND EXISTS(
                SELECT 1 FROM scheduling_leads deleted_lead
                WHERE deleted_lead.tenant_id=conversation.tenant_id
                  AND deleted_lead.deleted_at IS NOT NULL
                  AND (deleted_lead.id=conversation.lead_id
                    OR regexp_replace(deleted_lead.phone,'\\D','','g')=regexp_replace(conversation.contact_phone,'\\D','','g'))
              ) lead_deleted,
            EXISTS(
              SELECT 1 FROM scheduling_appointments appointment
              WHERE appointment.tenant_id=conversation.tenant_id
                AND appointment.lead_id=lead.id
                AND appointment.status IN ('confirmado','reagendado')
            ) unresolved_appointment,
            conversation.ai_commercial_override_at IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                WHERE GREATEST(
                  COALESCE(lead.commercial_updated_at,'epoch'::timestamptz),
                  COALESCE(lead.updated_at,'epoch'::timestamptz)
                ) > conversation.ai_commercial_override_at
              )
              AND NOT EXISTS (
                SELECT 1 FROM scheduling_appointments appointment
                WHERE appointment.tenant_id=conversation.tenant_id
                  AND appointment.lead_id=lead.id
                  AND appointment.status IN ('confirmado','reagendado')
                  AND appointment.updated_at > conversation.ai_commercial_override_at
              ) override_active
     FROM conversations conversation
     LEFT JOIN LATERAL (
       SELECT candidate.id,candidate.status,candidate.recovery_required,
              candidate.commercial_updated_at,candidate.updated_at
       FROM scheduling_leads candidate
       WHERE candidate.tenant_id=conversation.tenant_id
         AND candidate.deleted_at IS NULL
         AND (
           candidate.id=conversation.lead_id
           OR regexp_replace(candidate.phone,'\\D','','g')=regexp_replace(conversation.contact_phone,'\\D','','g')
         )
       ORDER BY (candidate.id=conversation.lead_id) DESC,candidate.updated_at DESC,candidate.id
       LIMIT 1
     ) lead ON true
     WHERE conversation.tenant_id=$1 AND conversation.id=$2`,
    [tenantId, conversationId]
  );
  const row = result.rows[0];
  if (!row) return {
    found: false,
    blocked: false,
    leadStatus: null,
    recoveryRequired: false,
    leadDeleted: false,
    unresolvedAppointment: false,
    overrideActive: false
  };
  const recoveryRequired = row.recovery_required === true;
  const leadDeleted = row.lead_deleted === true;
  const unresolvedAppointment = row.unresolved_appointment === true;
  const overrideActive = row.override_active === true;
  return {
    found: true,
    blocked: leadDeleted || commercialStateBlocksAiAutomation({
      leadStatus: row.lead_status,
      recoveryRequired,
      unresolvedAppointment,
      overrideActive
    }),
    leadStatus: row.lead_status,
    recoveryRequired,
    leadDeleted,
    unresolvedAppointment,
    overrideActive
  };
}
