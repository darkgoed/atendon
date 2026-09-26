import { createHash } from "node:crypto";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import {
  AI_CREDIT_PACK_CREDITS,
  AI_CREDIT_PACK_PRICE_CENTS,
  createCreditPackPurchase,
  grantPaidCreditPackage
} from "./credit-packs.js";
import { EfiPixAutomaticClient } from "./providers/efipay-pix-automatic.js";

/**
 * Lote mensal do Pix Automático (Efí) — pacote de créditos de IA
 * (SKU fixo: 50.000.000 créditos / R$157,00; a única concessão nasce do
 * webhook autenticado OU daqui).
 *
 * Duas fases, ambas SEM confiar em corpo de webhook: toda decisão de estado
 * na Efí vem de refetch autenticado (GET /v2/rec/:idRec e GET /v2/cobr/:txid).
 *
 * 1. CRIAÇÃO — mandatos APPROVED cujo próximo vencimento mensal
 *    (first_due_on + k meses, ancorado em first_due_on) está a 2–10 dias
 *    ganham UMA cobrança por ciclo (UNIQUE(mandate_id, due_on)), txid
 *    determinístico (sha256 de `efi-monthly:<mandateId>:<dueDate>`, 32 hex —
 *    faixa Pix 26–35 alfanuméricos) e compra/fatura idempotentes via
 *    createCreditPackPurchase com a mesma chave. Fatura recebe
 *    provider_id=Efí e external_id=txid na MESMA transação da linha de
 *    cobrança. Mandato local CANCELLED nunca cria cobrança, mesmo com
 *    autorização vigente na Efí; rec não-APROVADA na Efí também bloqueia e
 *    espelha o status terminal local.
 * 2. RECONCILIAÇÃO — cobranças PENDING recentes (due_on >= hoje-31): GET
 *    cobr autenticado; payload divergente (txid/idRec/valor/vencimento) é
 *    RECUSADO sem efeito. CONCLUIDA só vale se veio do GET e, sob lock da
 *    fatura, com mandato ainda APPROVED e compra PENDING_PAYMENT: fatura
 *    paga, payment registrado e pacote concedido na MESMA transação (grant
 *    idempotente por fatura). Status terminal de falha não concede e só marca
 *    a cobrança; CANCELADA após CONCLUIDA NÃO é prova de devolução do Pix
 *    (doc Efí de status), então um grant pago nunca é revogado aqui. Na
 *    janela, PUT /v2/cobr idempotente por txid (reexecuta até a Efí aceitar),
 *    precedido de releitura fresca do mandato local; CONCLUIDA do PUT é
 *    sempre reconfirmada pelo GET antes de qualquer grant.
 *
 * Nenhuma chamada externa acontece dentro de transação de banco; erros por
 * item são coletados e não derrubam o lote (worker roda por timer).
 */

export type EfiMonthlyClient = Pick<EfiPixAutomaticClient, "getRecurrence" | "createCharge" | "getCharge">;

export type EfiMonthlyProviderRow = { id: string; environment: string; credentials_encrypted: string | null };

export type EfiMonthlyBatchOptions = { clientFactory?: (provider: EfiMonthlyProviderRow) => EfiMonthlyClient };

export type EfiMonthlyBatchResult = {
  /** Linhas examinadas (fase de criação + reconciliação). */
  scanned: number;
  /** Novas linhas de cobrança locais criadas (janela 2–10 dias). */
  created: number;
  /** CONCLUIDA confirmada via GET: fatura paga + payment + grant. */
  granted: number;
  /** Reservado: o lote nunca revoga grant pago (CANCELADA não prova devolução) — sempre 0. */
  reversed: number;
  /** Cobrança falha/cancelada na Efí sem grant (nenhum efeito financeiro). */
  failed: number;
  /** Não-actionável nesta execução (mandato não aprovado, já liquidado...). */
  skipped: number;
  errors: Array<{ mandateId: string; dueOn: string; txid: string | null; message: string }>;
};

/** R$157,00 por ciclo — o mesmo par travado por CHECK nas migrations 0188/0193. */
const PRICE_BRL = (AI_CREDIT_PACK_PRICE_CENTS / 100).toFixed(2);

/** Status da cobrança Efí (GET/PUT /v2/cobr) → status local (CHECK da 0193). */
const CHARGE_STATUS: Record<string, string> = {
  CRIADA: "PENDING",
  ATIVA: "PENDING",
  CONCLUIDA: "APPROVED",
  CANCELADA: "CANCELLED",
  NEGADA: "REJECTED",
  REJEITADA: "REJECTED",
  EXPIRADA: "EXPIRED"
};
/** Status de falha terminal de cobrança: nunca concedem grant. */
const FAILURE_STATUS = new Set(["CANCELLED", "REJECTED", "EXPIRED"]);
/** Status terminal do mandato Efí (GET /v2/rec) espelhado no mandato local. */
const MANDATE_STATUS: Record<string, string> = {
  CANCELADA: "CANCELLED",
  REJEITADA: "REJECTED",
  EXPIRADA: "EXPIRED"
};

const WINDOW_MIN_DAYS = 2;
const WINDOW_MAX_DAYS = 10;
/** Reconciliação cobre cobranças pendentes até 31 dias após o vencimento. */
const RECONCILE_LOOKBACK_DAYS = 31;
/** Horizonte de busca do próximo vencimento mensal ancorado em first_due_on. */
const HORIZON_MONTHS = 24;

/** txid Pix determinístico: sha256 do par (mandato, vencimento) → 32 hex (26–35 alfanuméricos). */
function monthlyChargeTxid(mandateId: string, dueOn: string): string {
  return createHash("sha256").update(`efi-monthly:${mandateId}:${dueOn}`).digest("hex").slice(0, 32);
}

/** Chave de idempotência da compra/fatura, exigida pelo contrato do lote. */
function purchaseKey(mandateId: string, dueOn: string): string {
  return `efi-monthly:${mandateId}:${dueOn}`;
}

function remoteStatus(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

type ProviderRef = { provider_id: string; environment: string; credentials_encrypted: string | null };

type NextDueRow = ProviderRef & {
  mandate_id: string;
  tenant_id: string;
  external_id_rec: string;
  due_on: string;
};

type PendingChargeRow = ProviderRef & {
  charge_id: string;
  txid: string;
  due_on: string;
  invoice_id: string;
  in_window: boolean;
  mandate_id: string;
  tenant_id: string;
  mandate_status: string;
  external_id_rec: string;
};

type BatchOutcome = "granted" | "settled" | "skipped" | "failed" | "reversed";

function countOutcome(result: EfiMonthlyBatchResult, outcome: BatchOutcome): void {
  if (outcome === "granted") result.granted++;
  else if (outcome === "reversed") result.reversed++;
  else if (outcome === "failed") result.failed++;
  else result.skipped++;
}

function pushError(result: EfiMonthlyBatchResult, mandateId: string, dueOn: string, txid: string | null, error: unknown): void {
  result.errors.push({
    mandateId,
    dueOn,
    txid,
    message: error instanceof Error ? error.message : "erro desconhecido"
  });
}

/**
 * Rodízio: item examinado (falhou, ignorado ou ainda aguardando pagamento) vai
 * para o fim da fila (ORDER BY updated_at), para que `limit` linhas presas não
 * monopolizem o lote horário e deixem outras sem conciliação. Best-effort.
 */
async function rotateToQueueEnd(table: "ai_credit_pix_mandates" | "ai_credit_pix_charges", id: string): Promise<void> {
  await db.query(`UPDATE ${table} SET updated_at=now() WHERE id=$1`, [id]).catch(() => undefined);
}

/** Espelha status terminal da recorrência Efí no mandato local (nunca toca CREATING). */
async function mirrorMandateStatus(mandateId: string, status: string): Promise<void> {
  await db.query(
    `UPDATE ai_credit_pix_mandates SET status=$2,
            cancelled_at=CASE WHEN $2='CANCELLED' THEN now() ELSE cancelled_at END,
            updated_at=now()
      WHERE id=$1 AND status IN ('APPROVED','PENDING')`,
    [mandateId, status]
  );
}

/** Payload do GET cobr deve casar com a cobrança local: txid, idRec, valor e vencimento. */
function chargePayloadMatches(payload: Record<string, unknown>, charge: { txid: string; external_id_rec: string; due_on: string }): boolean {
  const valor = payload.valor as { original?: unknown } | undefined;
  const calendario = payload.calendario as { dataDeVencimento?: unknown } | undefined;
  return payload.txid === charge.txid
    && payload.idRec === charge.external_id_rec
    && String(valor?.original ?? "") === PRICE_BRL
    && String(calendario?.dataDeVencimento ?? "") === charge.due_on;
}

/**
 * Fase 1: cria linha de cobrança + compra/fatura idempotentes. A cobrança
 * nasce PENDING; o PUT na Efí acontece na fase 2 (idempotente por txid).
 */
async function createMonthlyCharge(candidate: NextDueRow, client: EfiMonthlyClient, result: EfiMonthlyBatchResult): Promise<void> {
  // Refetch autenticado: a autorização precisa estar APROVADA na Efí AGORA.
  const recurrence = await client.getRecurrence(candidate.external_id_rec);
  const recStatus = remoteStatus(recurrence.status);
  if (recStatus && recStatus !== "APROVADA") {
    const terminal = MANDATE_STATUS[recStatus];
    if (terminal) await mirrorMandateStatus(candidate.mandate_id, terminal);
    result.skipped++;
    return;
  }

  const { invoice } = await createCreditPackPurchase(candidate.tenant_id, purchaseKey(candidate.mandate_id, candidate.due_on));
  const txid = monthlyChargeTxid(candidate.mandate_id, candidate.due_on);

  await withTenantTransaction(db, candidate.tenant_id, async (client) => {
    const mandate = await client.query<{ status: string; external_id_rec: string | null }>(
      "SELECT status,external_id_rec FROM ai_credit_pix_mandates WHERE id=$1 FOR UPDATE", [candidate.mandate_id]);
    const row = mandate.rows[0];
    if (!row || row.status !== "APPROVED" || row.external_id_rec !== candidate.external_id_rec) {
      // Mandato deixou de estar aprovado (corrida com cancelamento) — nada nasce.
      result.skipped++;
      return;
    }
    // Fatura fica presa à Efí: provider_id + external_id = txid (mesma transação
    // da linha de cobrança; guardas recusam reuso por outro provedor/txid).
    const linked = await client.query<{ id: string }>(
      `UPDATE invoices SET provider_id=$2, external_id=$3, due_date=$4::date, updated_at=now()
        WHERE id=$1 AND (provider_id IS NULL OR provider_id=$2) AND (external_id IS NULL OR external_id=$3)
        RETURNING id`, [invoice.id, candidate.provider_id, txid, candidate.due_on]);
    if (!linked.rowCount) throw new Error(`fatura ${invoice.id} já vinculada a outro provedor/txid`);
    const inserted = await client.query<{ id: string; txid: string }>(
      `INSERT INTO ai_credit_pix_charges(mandate_id,due_on,txid,invoice_id,status)
       VALUES($1,$2::date,$3,$4,'PENDING')
       ON CONFLICT (mandate_id,due_on) DO NOTHING
       RETURNING id, txid`, [candidate.mandate_id, candidate.due_on, txid, invoice.id]);
    if (inserted.rows[0]) {
      result.created++;
      return;
    }
    // Linha pré-existente (reexecução/concorrência): txid tem de ser o mesmo.
    const existing = (await client.query<{ id: string; txid: string; invoice_id: string | null }>(
      "SELECT id,txid,invoice_id FROM ai_credit_pix_charges WHERE mandate_id=$1 AND due_on=$2::date",
      [candidate.mandate_id, candidate.due_on])).rows[0];
    if (!existing || existing.txid !== txid) throw new Error(`cobrança existente divergente (txid=${existing?.txid ?? "?"})`);
    if (!existing.invoice_id) {
      await client.query("UPDATE ai_credit_pix_charges SET invoice_id=$2, updated_at=now() WHERE id=$1", [existing.id, invoice.id]);
    }
  });
}

/**
 * Paga + concede sob lock da fatura (mesma ordem do webhook: invoice →
 * purchase → grant). Retorna settled/skipped quando NADA é concedido.
 */
async function confirmPaidCharge(charge: PendingChargeRow): Promise<Exclude<BatchOutcome, "failed" | "reversed">> {
  return await withTenantTransaction(db, charge.tenant_id, async (client) => {
    const chargeRow = await client.query<{ status: string }>(
      "SELECT status FROM ai_credit_pix_charges WHERE id=$1 FOR UPDATE", [charge.charge_id]);
    if (chargeRow.rows[0]?.status !== "PENDING") return "settled";
    const invoice = await client.query<{ id: string; tenant_id: string; kind: string; amount_cents: string; status: string }>(
      "SELECT id,tenant_id,kind,amount_cents,status FROM invoices WHERE id=$1 FOR UPDATE", [charge.invoice_id]);
    const inv = invoice.rows[0];
    if (!inv || inv.tenant_id !== charge.tenant_id || inv.kind !== "credit_package" || Number(inv.amount_cents) !== AI_CREDIT_PACK_PRICE_CENTS) {
      throw new Error(`fatura ${charge.invoice_id} inconsistente com a cobrança`);
    }
    if (["paid", "refunded", "charged_back"].includes(inv.status)) {
      await client.query("UPDATE ai_credit_pix_charges SET status='APPROVED',updated_at=now() WHERE id=$1", [charge.charge_id]);
      return "settled";
    }
    const mandate = await client.query<{ status: string }>(
      "SELECT status FROM ai_credit_pix_mandates WHERE id=$1 FOR UPDATE", [charge.mandate_id]);
    // Mandato já vinculado à cobrança: qualquer status serve (ex. CANCELLED
    // após stopMonthlyPixMandate); cobrança paga antes da parada deve ser
    // honrada. Só mandato ausente é rejeitado.
    if (!mandate.rows[0]) throw new Error(`mandato ${charge.mandate_id} não encontrado`);
    const purchase = await client.query<{ status: string }>(
      "SELECT status FROM ai_credit_purchases WHERE invoice_id=$1 FOR UPDATE", [inv.id]);
    const purchaseStatus = purchase.rows[0]?.status;
    if (!purchaseStatus) throw new Error(`compra da fatura ${inv.id} não encontrada`);
    if (purchaseStatus !== "PENDING_PAYMENT") return "skipped";
    await client.query(
      `INSERT INTO payments(tenant_id,invoice_id,provider_id,external_id,amount_cents,currency,status,method,paid_at)
       VALUES($1,$2,$3,$4,$5,'BRL','paid','pix_automatic',now())`,
      [charge.tenant_id, inv.id, charge.provider_id, charge.txid, AI_CREDIT_PACK_PRICE_CENTS]);
    await client.query("UPDATE invoices SET status='paid',paid_at=now(),updated_at=now() WHERE id=$1", [inv.id]);
    await client.query("UPDATE ai_credit_pix_charges SET status='APPROVED',updated_at=now() WHERE id=$1", [charge.charge_id]);
    await grantPaidCreditPackage(client, { tenantId: charge.tenant_id, invoiceId: inv.id, credits: AI_CREDIT_PACK_CREDITS });
    return "granted";
  });
}

/**
 * Falha terminal autenticada: marca a cobrança local PENDING. NUNCA revoca
 * grant nem estorna fatura: CANCELADA/NEGADA/EXPIRADA na cobrança NÃO comprova
 * devolução do Pix (estorno exigiria DEVOLVIDO no recurso Pix — tratamento
 * separado). Cobrança já resolvida (ex.: paga em corrida) fica intacta.
 */
async function applyFailureStatus(charge: PendingChargeRow, mapped: string): Promise<Extract<BatchOutcome, "failed" | "skipped">> {
  return await withTenantTransaction(db, charge.tenant_id, async (client) => {
    const current = await client.query<{ status: string }>(
      "SELECT status FROM ai_credit_pix_charges WHERE id=$1 FOR UPDATE", [charge.charge_id]);
    const fresh = current.rows[0];
    if (!fresh || fresh.status !== "PENDING") return "skipped";
    await client.query("UPDATE ai_credit_pix_charges SET status=$2,updated_at=now() WHERE id=$1", [charge.charge_id, mapped]);
    return "failed";
  });
}

/**
 * Fase 2: reconcilia uma cobrança PENDING com refetch autenticado. O GET cobr
 * vem SEMPRE antes de qualquer PUT — é a fonte do status; cobrança já existente
 * na Efí nunca é reenviada nem tem status sobrescrito pelo PUT. GET 404 só
 * autoriza o PUT idempotente por txid DENTRO da janela 2–10 dias, e somente
 * após mandato local APPROVED e recorrência APROVADA autenticados (status
 * ausente/desconhecido da rec NÃO autoriza); fora da janela o 404 não cobra.
 * Grant exige CONCLUIDA do GET autenticado com payload íntegro — o PUT nunca
 * concede. Erro diferente de 404 propaga (nada é criado).
 */
async function reconcilePendingCharge(charge: PendingChargeRow, client: EfiMonthlyClient, result: EfiMonthlyBatchResult): Promise<void> {
  let remote: { txid: string; status?: string; payload: Record<string, unknown> } | null = null;
  try {
    remote = await client.getCharge(charge.txid);
  } catch (error) {
    if (!(error instanceof Error && error.message === "Efi Pix API error (404)")) throw error;
  }
  if (remote) {
    if (!chargePayloadMatches((remote.payload ?? {}) as Record<string, unknown>, charge)) {
      throw new Error(`payload da cobrança ${charge.txid} divergente (txid/idRec/valor/vencimento)`);
    }
    const status = remoteStatus(remote.status);
    if (status === "CONCLUIDA") {
      countOutcome(result, await confirmPaidCharge(charge));
      return;
    }
    const mapped = CHARGE_STATUS[status];
    if (mapped && FAILURE_STATUS.has(mapped)) { countOutcome(result, await applyFailureStatus(charge, mapped)); return; }
    if (mapped === "PENDING") return; // ATIVA/CRIADA: aguardando pagamento
    throw new Error(`status de cobrança desconhecido na Efí: ${status || "(vazio)"}`);
  }
  // GET 404: a cobrança não existe na Efí. Só na janela ela pode ser criada.
  if (!charge.in_window) { result.skipped++; return; } // fora da janela não cobra
  // Mandato local CANCELLED vence a autorização Efí: nenhuma cobrança nova.
  if (charge.mandate_status !== "APPROVED") { result.skipped++; return; }
  const recurrence = await client.getRecurrence(charge.external_id_rec);
  // Fail-closed: status da rec ausente/desconhecido NÃO autoriza PUT.
  const recStatus = remoteStatus(recurrence.status);
  if (recStatus !== "APROVADA") {
    const terminal = MANDATE_STATUS[recStatus];
    if (terminal) await mirrorMandateStatus(charge.mandate_id, terminal);
    result.skipped++;
    return;
  }
  // PUT idempotente por txid; o PUT NUNCA concede — CONCLUIDA do PUT é
  // reconfirmada pelo GET autenticado antes de qualquer grant.
  // Releitura fresca: o snapshot da seleção pode ter ficado velho (stop local
  // concorrente durante o GET/rec) — mandato não mais APPROVED não recebe PUT.
  const fresh = await db.query<{ status: string }>(
    "SELECT status FROM ai_credit_pix_mandates WHERE id=$1", [charge.mandate_id]);
  if (fresh.rows[0]?.status !== "APPROVED") { result.skipped++; return; }
  const created = await client.createCharge(charge.txid, {
    idRec: charge.external_id_rec,
    originalCents: AI_CREDIT_PACK_PRICE_CENTS,
    dataDeVencimento: charge.due_on
  });
  const putStatus = remoteStatus(created.status);
  if (putStatus === "CONCLUIDA") {
    await confirmFromGet(client, charge, result);
    return;
  }
  const mapped = CHARGE_STATUS[putStatus];
  if (mapped && FAILURE_STATUS.has(mapped)) countOutcome(result, await applyFailureStatus(charge, mapped));
  // ATIVA/CRIADA: aguardando pagamento.
}

/** Reconfirma pelo GET autenticado (payload íntegro obrigatório) antes de conceder. */
async function confirmFromGet(client: EfiMonthlyClient, charge: PendingChargeRow, result: EfiMonthlyBatchResult): Promise<void> {
  const fresh = await client.getCharge(charge.txid);
  if (!chargePayloadMatches((fresh.payload ?? {}) as Record<string, unknown>, charge)) {
    throw new Error(`payload da cobrança ${charge.txid} divergente (txid/idRec/valor/vencimento)`);
  }
  if (remoteStatus(fresh.status) === "CONCLUIDA") countOutcome(result, await confirmPaidCharge(charge));
}

/** Próximo vencimento mensal ancorado em first_due_on (sem deriva de mês curto). */
const NEXT_DUE_SQL = `
  SELECT m.id AS mandate_id, m.tenant_id, m.external_id_rec,
         (m.first_due_on + (nd.k || ' months')::interval)::date::text AS due_on,
         p.id AS provider_id, p.environment, p.credentials_encrypted
    FROM ai_credit_pix_mandates m
    JOIN LATERAL (
      SELECT k FROM generate_series(0, $2) AS k
       WHERE (m.first_due_on + (k || ' months')::interval)::date >= CURRENT_DATE
       ORDER BY k LIMIT 1
    ) nd ON TRUE
    JOIN billing_providers p ON p.id = m.provider_id
   WHERE m.status = 'APPROVED'
     AND m.external_id_rec IS NOT NULL
     AND p.enabled AND p.credentials_encrypted IS NOT NULL
     AND (m.first_due_on + (nd.k || ' months')::interval)::date - CURRENT_DATE BETWEEN $3 AND $4
     AND NOT EXISTS (
       SELECT 1 FROM ai_credit_pix_charges x
        WHERE x.mandate_id = m.id
          AND x.due_on = (m.first_due_on + (nd.k || ' months')::interval)::date)
   ORDER BY m.updated_at, m.id
   LIMIT $1`;

const PENDING_CHARGES_SQL = `
  SELECT ch.id AS charge_id, ch.txid, ch.due_on::text AS due_on, ch.invoice_id,
         (ch.due_on - CURRENT_DATE) BETWEEN $2 AND $3 AS in_window,
         m.id AS mandate_id, m.tenant_id, m.status AS mandate_status, m.external_id_rec,
         p.id AS provider_id, p.environment, p.credentials_encrypted
    FROM ai_credit_pix_charges ch
    JOIN ai_credit_pix_mandates m ON m.id = ch.mandate_id
    JOIN billing_providers p ON p.id = m.provider_id
   WHERE ch.status = 'PENDING'
     AND ch.due_on >= CURRENT_DATE - $4::int
     AND ch.invoice_id IS NOT NULL
     AND m.external_id_rec IS NOT NULL
     AND p.enabled AND p.credentials_encrypted IS NOT NULL
   ORDER BY ch.updated_at, ch.id
   LIMIT $1`;

/**
 * Executa o lote mensal Efí (contrato do worker: Promise de objeto de contagens).
 * `limit` limita cada fase; `options.clientFactory` injeta o cliente Efí (testes).
 */
export async function runEfiPixMonthlyBatch(limit = 50, options: EfiMonthlyBatchOptions = {}): Promise<EfiMonthlyBatchResult> {
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const result: EfiMonthlyBatchResult = { scanned: 0, created: 0, granted: 0, reversed: 0, failed: 0, skipped: 0, errors: [] };
  const clients = new Map<string, EfiMonthlyClient>();
  const clientFor = (provider: ProviderRef): EfiMonthlyClient => {
    const cached = clients.get(provider.provider_id);
    if (cached) return cached;
    const row: EfiMonthlyProviderRow = { id: provider.provider_id, environment: provider.environment, credentials_encrypted: provider.credentials_encrypted };
    const client = options.clientFactory
      ? options.clientFactory(row)
      : new EfiPixAutomaticClient({
          credentialsEncrypted: provider.credentials_encrypted ?? "",
          encryptionKey: config.DATA_ENCRYPTION_KEY,
          environment: provider.environment === "production" ? "production" : "sandbox"
        });
    clients.set(provider.provider_id, client);
    return client;
  };

  const dueSoon = await db.query<NextDueRow>(NEXT_DUE_SQL, [boundedLimit, HORIZON_MONTHS, WINDOW_MIN_DAYS, WINDOW_MAX_DAYS]);
  for (const candidate of dueSoon.rows) {
    result.scanned++;
    try {
      await createMonthlyCharge(candidate, clientFor(candidate), result);
    } catch (error) {
      pushError(result, candidate.mandate_id, candidate.due_on, monthlyChargeTxid(candidate.mandate_id, candidate.due_on), error);
    } finally {
      await rotateToQueueEnd("ai_credit_pix_mandates", candidate.mandate_id);
    }
  }

  const pending = await db.query<PendingChargeRow>(PENDING_CHARGES_SQL, [boundedLimit, WINDOW_MIN_DAYS, WINDOW_MAX_DAYS, RECONCILE_LOOKBACK_DAYS]);
  for (const charge of pending.rows) {
    result.scanned++;
    try {
      await reconcilePendingCharge(charge, clientFor(charge), result);
    } catch (error) {
      pushError(result, charge.mandate_id, charge.due_on, charge.txid, error);
    } finally {
      await rotateToQueueEnd("ai_credit_pix_charges", charge.charge_id);
    }
  }
  return result;
}
