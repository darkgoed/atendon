import type { Pool, PoolClient } from "pg";
import type { MessageGateway } from "../messages/types.js";

export type ConfirmationMoment = "pos_agendamento" | "duas_horas_antes" | "quinze_minutos_antes";
export type ContactConfirmationState = "nao_solicitada" | "solicitada" | "confirmada" | "sem_resposta";
type AppointmentStatus = "confirmado" | "reagendado" | "cancelado" | "concluido" | "no_show";

const TEXTS: Record<ConfirmationMoment, Record<"confirmada" | "outros", readonly [string, string][]>> = {
  pos_agendamento: {
    outros: [
      ["Fechado, ficou marcado pra hoje às {time}", "Só me confirma se segue tudo certo pra gente se falar nesse horário?"],
      ["Combinado, nossa conversa ficou pra hoje às {time}", "Me dá um ok por aqui só pra eu confirmar contigo"],
      ["Prontinho, deixei marcado pra hoje às {time}", "Tá tudo certo pra você nesse horário?"]
    ],
    confirmada: []
  },
  duas_horas_antes: {
    confirmada: [
      ["[Nome], passando só pra lembrar que nossa conversa é hoje às {time}", "Nos falamos daqui a pouco"],
      ["[Nome], daqui a pouco temos nossa conversa das {time}", "Até já"],
      ["[Nome], nossa conversa segue marcada pras {time}", "Daqui a pouco nos falamos"]
    ],
    outros: [
      ["[Nome], nossa conversa está marcada pra hoje às {time}", "Segue tudo certo pra você?"],
      ["[Nome], passando pra confirmar nosso horário de hoje às {time}", "Consegue me dar um ok por aqui?"],
      ["[Nome], temos nossa conversa marcada pras {time} de hoje", "Posso manter esse horário contigo?"]
    ]
  },
  quinze_minutos_antes: {
    confirmada: [
      ["[Nome], nossa conversa começa em 15 minutinhos", "Até já"],
      ["[Nome], passando só pra avisar que daqui a 15 minutos começamos nossa conversa", "Nos falamos já"],
      ["[Nome], falta só 15 minutinhos pra nossa conversa", "Até daqui a pouco"]
    ],
    outros: [
      ["[Nome], nossa conversa começa em 15 minutos", "Segue tudo certo pra você participar?"],
      ["[Nome], estamos a 15 minutos do nosso horário", "Consegue me confirmar se vai conseguir entrar?"],
      ["[Nome], nossa conversa está marcada pra daqui a 15 minutos", "Se aconteceu algum imprevisto, me avisa por aqui"]
    ]
  }
};

function stableIndex(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(hash) % 3;
}

export function buildConfirmationMessage(input: {
  appointmentId: string; moment: ConfirmationMoment; name: string; formattedTime: string;
  state: ContactConfirmationState; variant?: number;
}): string {
  const group = input.state === "confirmada" && input.moment !== "pos_agendamento" ? "confirmada" : "outros";
  const choices = TEXTS[input.moment][group];
  // Normaliza para [0,2] mesmo com variant negativo: um índice fora da faixa
  // devolveria undefined e quebraria a montagem da mensagem.
  const index = input.variant === undefined
    ? stableIndex(`${input.appointmentId}:${input.moment}`)
    : ((Math.trunc(input.variant) % 3) + 3) % 3;
  const choice = choices[index]!;
  return `${choice[0].replaceAll("[Nome]", input.name).replaceAll("{time}", input.formattedTime)} ${choice[1]}`;
}

export function decideConfirmationMoments(input: { startAt: Date; now: Date; state: ContactConfirmationState; appointmentStatus: AppointmentStatus }): { moment: ConfirmationMoment; availableAt: Date }[] {
  if (["cancelado", "no_show"].includes(input.appointmentStatus)) return [];
  const start = input.startAt.getTime();
  const now = input.now.getTime();
  if (now >= start) return [];

  const moments: { moment: ConfirmationMoment; availableAt: Date }[] = [];

  // O Momento 1 NÃO entra aqui: quem envia o pedido de confirmação logo após
  // agendar é a própria IA, dentro da conversa (seção 21 do prompt). Se o
  // runtime também o enfileirasse, o contato receberia a mensagem duplicada.
  // Quem marca o estado como `solicitada` naquele caso é a criação do
  // agendamento, não este planejador.

  // Dentro de duas horas não acumulamos a janela anterior: só a última
  // tentativa ainda chega a tempo de ser útil ao contato.
  const twoHoursBefore = start - 2 * 60 * 60_000;
  if (twoHoursBefore >= now) moments.push({ moment: "duas_horas_antes", availableAt: new Date(twoHoursBefore) });

  const fifteenMinutesBefore = start - 15 * 60_000;
  if (fifteenMinutesBefore >= now) moments.push({ moment: "quinze_minutos_antes", availableAt: new Date(fifteenMinutesBefore) });

  return moments;
}

/**
 * Interpreta a resposta do contato ao pedido de confirmação.
 *
 * Falha fechada de propósito: qualquer negação ou hesitação impede a promoção
 * para `confirmada`, mesmo que a frase também contenha um "ok". Num fluxo
 * anti no-show, "acho que consigo" não é presença confirmada; tratar hesitação
 * como confirmação silencia justamente o lembrete que ainda seria útil.
 *
 * Recusa explícita NÃO vira `sem_resposta`, porque `sem_resposta` significa
 * silêncio e dispara a última tentativa de confirmação; quem recusou já
 * respondeu. Recusa pertence ao fluxo de cancelamento/remarcação, tratado fora
 * deste módulo.
 */
export function interpretConfirmationResponse(response: string, current: ContactConfirmationState): ContactConfirmationState {
  const normalized = response.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  if (/\bnao\b/.test(normalized) || /\b(nunca|cancelar|desist|remarcar|adiar)/.test(normalized)) return current;
  if (/\b(acho|talvez|provavel|acredito|devo conseguir|se der|se eu conseguir|tentar|vou tentar|possivelmente)\b/.test(normalized)) return current;
  if (/\b(sim|pode ser|confirmad|ok|beleza|ta certo|combinado|perfeito|vou sim|consigo|certo)\b/.test(normalized)) return "confirmada";
  return current;
}


// ---------------------------------------------------------------------------
// Persistência e envio
//
// Espelha meeting-contact-delivery.ts de propósito: claim transacional com
// lease, e falha de rede vira `uncertain` em vez de reenviar. Uma mensagem
// duplicada para o lead é pior do que uma mensagem não enviada.
// ---------------------------------------------------------------------------

const CONFIRMATION_LEASE_MS = 60_000;

/**
 * Momentos disparados pelo runtime a partir do horário da reunião.
 *
 * `pos_agendamento` NÃO entra aqui de propósito: quem envia o pedido de
 * confirmação logo após agendar é a própria IA, dentro da conversa (seção 21
 * do prompt). Enfileirá-lo aqui produziria mensagem duplicada e, pior, uma
 * confirmação retroativa — "Fechado, ficou marcado pra hoje às 09h" enviada
 * dias depois do agendamento, com o "hoje" errado. Os textos do Momento 1
 * seguem no catálogo porque descrevem o que a IA deve dizer.
 */
const RUNTIME_SCHEDULED_MOMENTS: readonly ConfirmationMoment[] = [
  "duas_horas_antes",
  "quinze_minutos_antes"
];

/**
 * Texto gravado no enfileiramento. Nunca é enviado: o texto real é redigido no
 * claim, com o horário e o estado de confirmação vigentes naquele momento.
 * A coluna exige ao menos 1 caractere, por isso não usamos string vazia.
 */
const PENDING_MESSAGE_PLACEHOLDER = "(a redigir no envio)";

/** Momentos cujo texto pede uma ação do contato (os demais só lembram). */
const MOMENTS_REQUESTING_CONFIRMATION: readonly ConfirmationMoment[] = [
  "pos_agendamento",
  "duas_horas_antes",
  "quinze_minutos_antes"
];

export interface ClaimedMeetingConfirmation {
  id: string;
  tenantId: string;
  appointmentId: string;
  conversationId: string;
  sessionId: string;
  destination: string;
  messageText: string;
  moment: ConfirmationMoment;
  state: ContactConfirmationState;
}

export interface MeetingConfirmationPage {
  ids: string[];
  nextCursor: string | null;
}

async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export class MeetingConfirmationRepository {
  constructor(
    private readonly pool: Pool,
    private readonly leaseMs = CONFIRMATION_LEASE_MS
  ) {}

  /**
   * Enfileira os momentos ainda aplicáveis para um agendamento.
   *
   * Todos os JOINs casam (id, tenant_id) para que conversa e sessão sejam
   * obrigatoriamente do mesmo tenant do agendamento: o isolamento é garantido
   * pela query, não por checagem em código.
   */
  async enqueueForAppointment(appointmentId: string): Promise<string[]> {
    return withTransaction(this.pool, async (client) => {
      const selected = await client.query<{
        id: string;
        tenant_id: string;
        start_at: Date;
        status: AppointmentStatus;
        contact_confirmation_state: ContactConfirmationState;
        lead_name: string | null;
        contact_phone: string;
        conversation_id: string;
        session_id: string;
        contact_jid: string | null;
        timezone: string;
      }>(
        `SELECT a.id, a.tenant_id, a.start_at, a.status, a.contact_confirmation_state,
                lead.name lead_name, lead.phone contact_phone,
                conversation.id conversation_id, conversation.session_id, conversation.contact_jid,
                tenant.timezone
         FROM scheduling_appointments a
         JOIN scheduling_leads lead ON lead.id = a.lead_id AND lead.tenant_id = a.tenant_id
         JOIN tenants tenant ON tenant.id = a.tenant_id
         JOIN conversations conversation
           ON conversation.lead_id = a.lead_id AND conversation.tenant_id = a.tenant_id
         WHERE a.id = $1
         ORDER BY conversation.last_message_at DESC NULLS LAST, conversation.id
         LIMIT 1`,
        [appointmentId]
      );
      const appointment = selected.rows[0];
      if (!appointment) return [];

      const planned = decideConfirmationMoments({
        startAt: appointment.start_at,
        now: new Date(),
        state: appointment.contact_confirmation_state,
        appointmentStatus: appointment.status
      }).filter((entry) => RUNTIME_SCHEDULED_MOMENTS.includes(entry.moment));

      const inserted: string[] = [];
      for (const entry of planned) {
        // message_text entra vazio de propósito e é redigido no momento do
        // envio (claim). Congelar o texto aqui produziria "hoje" errado para
        // uma reunião de amanhã e ignoraria uma confirmação que o contato
        // tenha dado entre o enfileiramento e a janela de disparo.
        const row = await client.query<{ id: string }>(
          `INSERT INTO scheduling_meeting_confirmation_outbox(
             tenant_id, appointment_id, conversation_id, session_id,
             contact_phone, contact_jid, moment, message_text, available_at
           )
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (tenant_id, appointment_id, moment) DO NOTHING
           RETURNING id`,
          [
            appointment.tenant_id, appointment.id, appointment.conversation_id,
            appointment.session_id, appointment.contact_phone, appointment.contact_jid,
            entry.moment, PENDING_MESSAGE_PLACEHOLDER, entry.availableAt
          ]
        );
        if (row.rows[0]) inserted.push(row.rows[0].id);
      }
      return inserted;
    });
  }

  async claim(outboxId: string): Promise<ClaimedMeetingConfirmation | null> {
    return withTransaction(this.pool, async (client) => {
      const selected = await client.query<{
        id: string; tenant_id: string; appointment_id: string; conversation_id: string;
        session_id: string; contact_phone: string; contact_jid: string | null;
        message_text: string; moment: ConfirmationMoment; status: string;
        attempted_at: Date | null; processing_started_at: Date | null;
        available: boolean; contact_confirmation_state: ContactConfirmationState;
        appointment_status: AppointmentStatus; start_at: Date;
        lead_name: string | null; timezone: string;
      }>(
        `SELECT outbox.id, outbox.tenant_id, outbox.appointment_id, outbox.conversation_id,
                outbox.session_id, outbox.contact_phone, outbox.contact_jid,
                outbox.message_text, outbox.moment, outbox.status,
                outbox.attempted_at, outbox.processing_started_at,
                outbox.available_at <= now() available,
                appointment.contact_confirmation_state,
                appointment.status appointment_status,
                appointment.start_at,
                lead.name lead_name,
                tenant.timezone
         FROM scheduling_meeting_confirmation_outbox outbox
         JOIN scheduling_appointments appointment
           ON appointment.id = outbox.appointment_id AND appointment.tenant_id = outbox.tenant_id
         JOIN scheduling_leads lead
           ON lead.id = appointment.lead_id AND lead.tenant_id = appointment.tenant_id
         JOIN tenants tenant ON tenant.id = outbox.tenant_id
         WHERE outbox.id = $1
         FOR UPDATE OF outbox SKIP LOCKED`,
        [outboxId]
      );
      const row = selected.rows[0];
      if (!row) return null;
      if (["sent", "suppressed", "failed", "uncertain"].includes(row.status)) return null;

      const leaseExpired = row.status === "processing"
        && (row.processing_started_at === null
          || row.processing_started_at.getTime() <= Date.now() - this.leaseMs);
      if (row.status === "processing" && !leaseExpired) return null;
      if (row.status === "pending" && !row.available) return null;

      // Lease expirado depois de um envio iniciado: não repetimos, porque o
      // provider pode ter aceitado a mensagem.
      if (leaseExpired && row.attempted_at) {
        await client.query(
          `UPDATE scheduling_meeting_confirmation_outbox
           SET status='uncertain', last_error=$3, completed_at=now(), processing_started_at=NULL, updated_at=now()
           WHERE id=$1 AND tenant_id=$2`,
          [row.id, row.tenant_id, "Lease expirou após o envio externo ter sido iniciado"]
        );
        return null;
      }

      // Reunião cancelada ou já realizada entre o enfileiramento e agora:
      // a mensagem perdeu o sentido e não deve ser enviada.
      if (["cancelado", "no_show", "concluido"].includes(row.appointment_status)) {
        await client.query(
          `UPDATE scheduling_meeting_confirmation_outbox
           SET status='suppressed', completed_at=now(), processing_started_at=NULL, updated_at=now()
           WHERE id=$1 AND tenant_id=$2`,
          [row.id, row.tenant_id]
        );
        return null;
      }

      const claimed = await client.query<{ id: string }>(
        `UPDATE scheduling_meeting_confirmation_outbox
         SET status='processing', attempt_count=attempt_count+1,
             processing_started_at=now(), updated_at=now()
         WHERE id=$1 AND tenant_id=$2
         RETURNING id`,
        [row.id, row.tenant_id]
      );
      if (!claimed.rows[0]) return null;

      // O texto é redigido AGORA, não no enfileiramento: usa o horário da
      // reunião no fuso do tenant e o estado de confirmação vigente, de forma
      // que quem confirmou receba lembrete e quem não confirmou receba pedido.
      const formattedTime = new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: row.timezone || "America/Sao_Paulo"
      }).format(row.start_at);
      const contactName = row.lead_name?.trim().split(/\s+/)[0] ?? "";
      const messageText = buildConfirmationMessage({
        appointmentId: row.appointment_id,
        moment: row.moment,
        name: contactName,
        formattedTime,
        state: row.contact_confirmation_state
      });
      await client.query(
        "UPDATE scheduling_meeting_confirmation_outbox SET message_text=$3, updated_at=now() WHERE id=$1 AND tenant_id=$2",
        [row.id, row.tenant_id, messageText]
      );

      return {
        id: row.id,
        tenantId: row.tenant_id,
        appointmentId: row.appointment_id,
        conversationId: row.conversation_id,
        sessionId: row.session_id,
        destination: row.contact_jid ?? row.contact_phone,
        messageText,
        moment: row.moment,
        state: row.contact_confirmation_state
      };
    });
  }

  async markAttemptStarted(delivery: ClaimedMeetingConfirmation): Promise<boolean> {
    const updated = await this.pool.query<{ id: string }>(
      `UPDATE scheduling_meeting_confirmation_outbox
       SET attempted_at=now(), updated_at=now()
       WHERE id=$1 AND tenant_id=$2 AND status='processing' AND attempted_at IS NULL
       RETURNING id`,
      [delivery.id, delivery.tenantId]
    );
    return Boolean(updated.rows[0]);
  }

  async markSent(delivery: ClaimedMeetingConfirmation, externalMessageId: string): Promise<void> {
    await this.pool.query(
      `UPDATE scheduling_meeting_confirmation_outbox
       SET status='sent', external_message_id=$3, completed_at=now(),
           processing_started_at=NULL, last_error=NULL, updated_at=now()
       WHERE id=$1 AND tenant_id=$2 AND status='processing'`,
      [delivery.id, delivery.tenantId, externalMessageId]
    );
    if (MOMENTS_REQUESTING_CONFIRMATION.includes(delivery.moment) && delivery.state !== "confirmada") {
      await this.markConfirmationRequested(delivery.tenantId, delivery.appointmentId);
    }
  }

  async markUncertain(delivery: ClaimedMeetingConfirmation, error: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE scheduling_meeting_confirmation_outbox
       SET status='uncertain', last_error=$3, completed_at=now(),
           processing_started_at=NULL, updated_at=now()
       WHERE id=$1 AND tenant_id=$2`,
      [delivery.id, delivery.tenantId, (error instanceof Error ? error.message : String(error)).slice(0, 2_000)]
    );
  }

  async markSuppressed(delivery: ClaimedMeetingConfirmation): Promise<void> {
    await this.pool.query(
      `UPDATE scheduling_meeting_confirmation_outbox
       SET status='suppressed', completed_at=now(), processing_started_at=NULL, updated_at=now()
       WHERE id=$1 AND tenant_id=$2`,
      [delivery.id, delivery.tenantId]
    );
  }

  /** Nunca rebaixa um estado já confirmado. */
  async markConfirmationRequested(tenantId: string, appointmentId: string): Promise<void> {
    await this.pool.query(
      `UPDATE scheduling_appointments
       SET contact_confirmation_state='solicitada', contact_confirmation_requested_at=now(), updated_at=now()
       WHERE id=$1 AND tenant_id=$2 AND contact_confirmation_state='nao_solicitada'`,
      [appointmentId, tenantId]
    );
  }

  /** Promove o agendamento a CONFIRMADO quando o contato afirma presença.
   *
   * Só vale a partir de `solicitada`: sem essa trava, qualquer "ok" ou
   * "perfeito" dito em outro ponto da conversa marcaria o lead como confirmado
   * e silenciaria os lembretes de quem nunca confirmou nada.
   */
  async registerContactConfirmation(tenantId: string, appointmentId: string, response: string): Promise<boolean> {
    const current = await this.pool.query<{ contact_confirmation_state: ContactConfirmationState }>(
      "SELECT contact_confirmation_state FROM scheduling_appointments WHERE id=$1 AND tenant_id=$2",
      [appointmentId, tenantId]
    );
    const state = current.rows[0]?.contact_confirmation_state;
    if (state !== "solicitada") return false;
    if (interpretConfirmationResponse(response, state) !== "confirmada") return false;
    const updated = await this.pool.query<{ id: string }>(
      `UPDATE scheduling_appointments
       SET contact_confirmation_state='confirmada', contact_confirmation_at=now(), updated_at=now()
       WHERE id=$1 AND tenant_id=$2 AND contact_confirmation_state <> 'confirmada'
       RETURNING id`,
      [appointmentId, tenantId]
    );
    return Boolean(updated.rows[0]);
  }

  /**
   * Agendamentos futuros que ainda não têm todas as linhas de confirmação.
   *
   * O enfileiramento é feito por varredura em vez de gancho na criação do
   * agendamento: assim vale também para reagendamento e para agendamentos
   * criados antes desta funcionalidade existir, e uma janela perdida por
   * indisponibilidade do worker se recupera sozinha na próxima passada.
   * `enqueueForAppointment` usa ON CONFLICT DO NOTHING, então reprocessar é
   * inofensivo.
   *
   * Cobre apenas os Momentos 2 e 3: o Momento 1 é enviado pela própria IA na
   * conversa, e quem marca `solicitada` naquele caso é
   * `markConfirmationRequested`.
   */
  async findAppointmentsNeedingConfirmation(limit = 100): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT a.id
       FROM scheduling_appointments a
       WHERE a.status IN ('confirmado','reagendado')
         AND a.start_at > now()
         AND a.start_at < now() + interval '7 days'
         AND EXISTS (
           SELECT 1 FROM conversations c
           WHERE c.lead_id = a.lead_id AND c.tenant_id = a.tenant_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM scheduling_meeting_confirmation_outbox o
           WHERE o.appointment_id = a.id AND o.tenant_id = a.tenant_id
             AND o.moment = 'quinze_minutos_antes'
         )
       ORDER BY a.start_at
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => row.id);
  }

  async findDuePage(limit = 100, afterId?: string): Promise<MeetingConfirmationPage> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM scheduling_meeting_confirmation_outbox
       WHERE (
         (status='pending' AND available_at <= now())
         OR (status='processing'
             AND COALESCE(processing_started_at,'-infinity'::timestamptz)
                 <= now()-($2::bigint * interval '1 millisecond'))
       )
       AND ($3::uuid IS NULL OR id > $3)
       ORDER BY id
       LIMIT $1`,
      [limit, this.leaseMs, afterId ?? null]
    );
    const ids = result.rows.map((row) => row.id);
    return { ids, nextCursor: ids.length === limit ? ids.at(-1)! : null };
  }
}

export class MeetingConfirmationProcessor {
  /**
   * `isEnabled` NÃO tem default permissivo de propósito: sem um verificador de
   * feature flag explícito, nada é enviado. Um default `true` faria o gate
   * falhar aberto e mandaria mensagem a lead real com a flag desligada.
   */
  constructor(
    private readonly repository: MeetingConfirmationRepository,
    private readonly gateway: Pick<MessageGateway, "sendText">,
    private readonly isEnabled: (tenantId: string) => Promise<boolean>
  ) {}

  async process(outboxId: string): Promise<"skipped" | "sent" | "uncertain" | "suppressed"> {
    const delivery = await this.repository.claim(outboxId);
    if (!delivery) return "skipped";

    // Gate antes de qualquer efeito externo.
    if (!await this.isEnabled(delivery.tenantId)) {
      await this.repository.markSuppressed(delivery);
      return "suppressed";
    }

    if (!await this.repository.markAttemptStarted(delivery)) return "skipped";
    try {
      const sent = await this.gateway.sendText(delivery.sessionId, delivery.destination, delivery.messageText);
      await this.repository.markSent(delivery, sent.externalId);
      return "sent";
    } catch (error) {
      await this.repository.markUncertain(delivery, error);
      return "uncertain";
    }
  }
}
