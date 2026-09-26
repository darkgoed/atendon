/**
 * Mandato Pix Automático (Efí) — assinatura mensal do pacote de créditos de IA
 * (50.000.000 créditos por R$157,00; mesmo SKU fixo de credit-packs.ts, travado
 * por CHECK na migration 0193).
 *
 * Jornada 2: aqui nascem loc + rec na Efí e o pixCopiaECola devolvido ao
 * usuário; a aprovação acontece no app do banco dele. Quem chama start é a
 * rota billing.manage, SEMPRE após ação explícita do usuário — nada neste
 * módulo configura recorrência por conta própria, e valor/periodicidade não
 * vêm de fora (constantes do servidor + CHECK do banco).
 *
 * Fail-closed por princípio:
 * - só opera com o provider 'efipay' habilitado e conectado em produção, com
 *   credenciais gravadas;
 * - primeiro vencimento: 1º dia do mês seguinte, sempre ≥ 10 dias no futuro;
 * - recuperação de CREATING nunca reenvia POST /v2/rec (uma resposta perdida
 *   pode ter deixado rec órfã na Efí; reenviar criaria 2 mandatos remotos) —
 *   só o stop local libera o slot;
 * - status local só vira APPROVED com GET /v2/rec autenticado devolvendo
 *   APROVADA;
 * - stop é LOCAL: marca CANCELLED (nenhum fluxo gera cobrança nova a partir
 *   daqui) e cancela cobranças futuras ativas via cancelCharge, sem apagar
 *   pagamentos. A API Pix da Efí NÃO documenta endpoint para cancelar a
 *   recorrência em si (o cliente não expõe um): nada aqui alega revogar a
 *   autorização no banco do pagador — isso cabe ao titular, no app do banco.
 */

import type { PoolClient } from "pg";
import { db } from "../db/client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { config } from "../config.js";
import { AI_CREDIT_PACK_CREDITS, AI_CREDIT_PACK_PRICE_CENTS } from "./credit-packs.js";
import { EfiPixAutomaticClient, type EfiTransport } from "./providers/efipay-pix-automatic.js";

export type MonthlyPixMandateStatus = "CREATING" | "PENDING" | "APPROVED" | "CANCELLED" | "REJECTED" | "EXPIRED";
export type MonthlyPixMandateView = {
  id: string;
  status: MonthlyPixMandateStatus;
  firstDueOn: string;
  pixCopiaECola: string | null;
};

type MandateRow = {
  id: string;
  tenant_id: string;
  provider_id: string;
  external_id_rec: string | null;
  status: string;
  first_due_on: string;
  location_id: string | null;
};

type Debtor = { nome: string; cpf?: string; cnpj?: string };

const ACTIVE_STATUSES_SQL = "('CREATING','PENDING','APPROVED')";
const MANDATE_COLUMNS = "id,tenant_id,provider_id,external_id_rec,status,to_char(first_due_on,'YYYY-MM-DD') AS first_due_on,location_id";
const ACTIVE_MANDATE_SQL = `SELECT ${MANDATE_COLUMNS} FROM ai_credit_pix_mandates WHERE tenant_id=$1 AND status IN ${ACTIVE_STATUSES_SQL} ORDER BY created_at DESC, id DESC LIMIT 1`;

/** status de /v2/rec (Efí) → status local; desconhecido deixa o local como está. */
const EFI_REC_STATUS: Record<string, MonthlyPixMandateStatus> = {
  CRIADA: "PENDING",
  APROVADA: "APPROVED",
  REJEITADA: "REJECTED",
  EXPIRADA: "EXPIRED",
  CANCELADA: "CANCELLED",
};

let testOverrides: { providerCode: string; transport: EfiTransport } | undefined;
/** Somente testes de integração: provider dedicado (não mexe nas linhas globais) + transport falso. */
export function setEfiPixMandateOverridesForTests(overrides: { providerCode: string; transport: EfiTransport } | undefined): void {
  testOverrides = overrides;
}

/**
 * 1º dia do mês seguinte; se faltar menos de 10 dias, empurra para hoje+10 —
 * isso só acontece na última semana do mês, quando hoje+10 já cai no mês
 * seguinte. UTC de ponta a ponta: na virada, o UTC enxerga o mês seguinte até
 * um dia antes do horário do Brasil; conserva (cobra depois, nunca antes).
 */
export function firstDueOnFrom(now = new Date()): string {
  const firstOfNextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const tenDaysOut = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 10);
  return new Date(Math.max(firstOfNextMonth, tenDaysOut)).toISOString().slice(0, 10);
}

/** Portão: provider Efí habilitado e conectado em produção, com credenciais. */
async function requireProductionEfipay(): Promise<{ id: string; credentialsEncrypted: string }> {
  const row = (await db.query<{ id: string; credentials_encrypted: string | null }>(
    `SELECT id,credentials_encrypted FROM billing_providers
      WHERE code=$1 AND environment='production' AND enabled=true AND status IN ('CONNECTED','TOKEN_EXPIRING')`,
    [testOverrides?.providerCode ?? "efipay"])).rows[0];
  if (!row?.credentials_encrypted) {
    throw new Error("Efí (Pix Automático) não está habilitada e conectada em produção com credenciais");
  }
  return { id: row.id, credentialsEncrypted: row.credentials_encrypted };
}

function efiClient(credentialsEncrypted: string): EfiPixAutomaticClient {
  return new EfiPixAutomaticClient({
    credentialsEncrypted,
    encryptionKey: config.DATA_ENCRYPTION_KEY,
    environment: "production",
    transport: testOverrides?.transport,
  });
}

/**
 * Devedor da recorrência: nome vem de tenants.name, documento de
 * billing_accounts.document. O documento NUNCA é ecoado — nem em erro, nem em
 * log, nem em retorno.
 */
async function debtorFor(client: PoolClient, tenantId: string): Promise<Debtor> {
  const account = (await client.query<{ document: string | null }>(
    "SELECT document FROM billing_accounts WHERE tenant_id=$1", [tenantId])).rows[0];
  const tenant = (await client.query<{ name: string }>(
    "SELECT name FROM tenants WHERE id=$1", [tenantId])).rows[0];
  const nome = tenant?.name?.trim() ?? "";
  const digits = (account?.document ?? "").replace(/\D/g, "");
  if (!nome) throw new Error("tenant sem nome para o devedor da recorrência");
  if (digits.length !== 11 && digits.length !== 14) {
    throw new Error("conta de cobrança sem documento do titular (CPF/CNPJ) cadastrado");
  }
  return { nome, ...(digits.length === 11 ? { cpf: digits } : { cnpj: digits }) };
}

async function audit(client: PoolClient, tenantId: string, actorUserId: string, action: string, mandateId: string, metadata: Record<string, unknown>): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata)
     VALUES($1,$2,'workspace',$3,'ai_credit_pix_mandate',$4,$5)`,
    [actorUserId, tenantId, action, mandateId, metadata]);
}

function view(row: MandateRow, pixCopiaECola: string | null): MonthlyPixMandateView {
  return { id: row.id, status: row.status as MonthlyPixMandateStatus, firstDueOn: row.first_due_on, pixCopiaECola };
}

/** GET autenticado na Efí: única fonte para promover o status local. */
async function syncRecurrence(client: EfiPixAutomaticClient, row: MandateRow): Promise<MonthlyPixMandateView> {
  const remote = await client.getRecurrence(row.external_id_rec ?? "");
  const status = EFI_REC_STATUS[remote.status ?? ""] ?? row.status;
  let current = row;
  if (status !== row.status) {
    await withTenantTransaction(db, row.tenant_id, async (dbClient) => {
      // Guarda de estado ativo: um stop concorrente (CANCELLED) não é desfeito
      // por um GET que chegou depois.
      const updated = await dbClient.query<MandateRow>(
        `UPDATE ai_credit_pix_mandates SET status=$2,
            approved_at = CASE WHEN $2='APPROVED' THEN COALESCE(approved_at,now()) ELSE approved_at END,
            cancelled_at = CASE WHEN $2='CANCELLED' THEN COALESCE(cancelled_at,now()) ELSE cancelled_at END,
            updated_at = now()
          WHERE id=$1 AND status IN ${ACTIVE_STATUSES_SQL}
          RETURNING ${MANDATE_COLUMNS}`,
        [row.id, status]);
      if (updated.rows[0]) current = updated.rows[0];
    });
  }
  return view(current, remote.pixCopiaECola ?? null);
}

type StagedMandate = { created: false; row: MandateRow } | { created: true; row: MandateRow; debtor: Debtor };

export async function startMonthlyPixMandate(tenantId: string, actorUserId: string): Promise<MonthlyPixMandateView> {
  if (!actorUserId.trim()) throw new Error("actor is required");
  const provider = await requireProductionEfipay();

  // TX1 (lock por tenant): re-checa mandato em curso e grava CREATING. O
  // índice parcial único (uq_ai_credit_pix_mandates_active_tenant) é a segunda
  // linha de defesa contra 2 mandatos em curso.
  const staged = await withTenantTransaction(db, tenantId, async (client): Promise<StagedMandate> => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ai-credit-pix-mandate:' || $1))", [tenantId]);
    const existing = (await client.query<MandateRow>(ACTIVE_MANDATE_SQL, [tenantId])).rows[0];
    if (existing) return { created: false, row: existing };
    const debtor = await debtorFor(client, tenantId);
    const inserted = (await client.query<MandateRow>(
      `INSERT INTO ai_credit_pix_mandates(tenant_id,provider_id,status,first_due_on,consent_actor_user_id,credits,price_cents)
       VALUES($1,$2,'CREATING',$3::date,$4,$5,$6)
       RETURNING ${MANDATE_COLUMNS}`,
      [tenantId, provider.id, firstDueOnFrom(), actorUserId, AI_CREDIT_PACK_CREDITS, AI_CREDIT_PACK_PRICE_CENTS])).rows[0];
    await audit(client, tenantId, actorUserId, "PIX_MANDATE_STARTED", inserted.id, { status: "CREATING", firstDueOn: inserted.first_due_on });
    return { created: true, row: inserted, debtor };
  });

  if (!staged.created) {
    // Mandato já em curso: NUNCA reenvia criação remota. CREATING sem idRec
    // volta como está (recuperação fail-closed); com idRec, sincroniza por GET.
    if (!staged.row.external_id_rec) return view(staged.row, null);
    return await syncRecurrence(efiClient(provider.credentialsEncrypted), staged.row);
  }

  // Criação remota FORA de transação. Se falhar, a linha fica CREATING sem
  // idRec: sem reenvio automático (a resposta perdida pode ter deixado uma rec
  // órfã na Efí) — o usuário Para (CANCELLED local) e recomeça.
  const client = efiClient(provider.credentialsEncrypted);
  const location = await client.createLocation();
  const recurrence = await client.createRecurrence({
    locationId: location.id,
    devedor: staged.debtor,
    // vínculo do exemplo oficial Efí (Jornada 2): contrato = id do mandato sem
    // hífens (32 ≤ 35 chars, estável), objeto = descrição fixa do pacote, sem PII.
    contrato: staged.row.id.replace(/-/g, ""),
    objeto: "Assinatura mensal do pacote de 50 milhões de créditos de IA (R$ 157,00/mês)",
    valorRecCents: AI_CREDIT_PACK_PRICE_CENTS,
    dataInicial: staged.row.first_due_on,
    periodicidade: "MENSAL",
  });
  if (!recurrence.idRec) throw new Error("Efí não devolveu idRec da recorrência");
  const activated = (await withTenantTransaction(db, tenantId, (dbClient) =>
    dbClient.query<MandateRow>(
      `UPDATE ai_credit_pix_mandates SET location_id=$2, external_id_rec=$3, status='PENDING', updated_at=now()
        WHERE id=$1 AND status='CREATING'
        RETURNING ${MANDATE_COLUMNS}`,
      [staged.row.id, String(location.id), recurrence.idRec]))).rows[0];
  if (!activated) {
    // O usuário Parou enquanto a criação remota voava: a rec existe na Efí, o
    // local está CANCELLED — fail-closed vence e o QR não é servido.
    const row = (await db.query<MandateRow>(
      `SELECT ${MANDATE_COLUMNS} FROM ai_credit_pix_mandates WHERE id=$1`, [staged.row.id])).rows[0];
    if (!row) throw new Error("mandato sumiu durante a criação remota");
    return view(row, null);
  }

  // dadosQR.pixCopiaECola só existe na consulta; o GET autenticado também
  // confirma o status remoto antes de qualquer promoção local.
  return await syncRecurrence(client, activated);
}

export async function getMonthlyPixMandate(tenantId: string): Promise<MonthlyPixMandateView | null> {
  const row = (await db.query<MandateRow>(ACTIVE_MANDATE_SQL, [tenantId])).rows[0];
  if (!row) return null;
  if (!row.external_id_rec) return view(row, null); // CREATING: nada remoto para consultar
  return await syncRecurrence(efiClient((await requireProductionEfipay()).credentialsEncrypted), row);
}

export async function stopMonthlyPixMandate(tenantId: string, actorUserId: string): Promise<MonthlyPixMandateView | null> {
  if (!actorUserId.trim()) throw new Error("actor is required");

  // TX1 (lock por tenant): mandato em curso + cobranças futuras ativas.
  const target = await withTenantTransaction(db, tenantId, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ai-credit-pix-mandate:' || $1))", [tenantId]);
    const row = (await client.query<MandateRow>(ACTIVE_MANDATE_SQL, [tenantId])).rows[0];
    if (!row) return null;
    // due_on > hoje: cobrança vencendo hoje já tem a 1ª liquidação agendada —
    // PATCH /v2/cobr devolve 400 ("data igual ou maior que a data prevista da
    // primeira tentativa de liquidação"). Fica PENDING; webhook/reconciliação
    // a fecham, e o lote roda mesmo com o mandato CANCELLED.
    const charges = (await client.query<{ id: string; txid: string }>(
      `SELECT id,txid FROM ai_credit_pix_charges
        WHERE mandate_id=$1 AND status='PENDING' AND due_on>CURRENT_DATE ORDER BY due_on`,
      [row.id])).rows;
    return { row, charges };
  });
  if (!target) return null;

  // Cobranças futuras ativas: PATCH /v2/cobr CANCELADA. Pagamentos existentes
  // não são apagados; cobrança que a Efí já encerrou é tolerada (o GET confirma
  // o estado real antes de desistir) — paga/expirada fica com o webhook, não é
  // dono dela. Falha real: stop NÃO conclui — o mandato segue ativo e a chamada
  // pode ser repetida.
  if (target.charges.length > 0) {
    const client = efiClient((await requireProductionEfipay()).credentialsEncrypted);
    for (const charge of target.charges) {
      try {
        await client.cancelCharge(charge.txid);
      } catch {
        const remoteStatus = (await client.getCharge(charge.txid)).status ?? "";
        if (remoteStatus === "CRIADA" || remoteStatus === "ATIVA") {
          throw new Error(`Efí recusou cancelar a cobrança futura ${charge.txid}; mandato segue ativo`);
        }
        if (remoteStatus !== "CANCELADA") continue; // CONCLUIDA/EXPIRADA/REJEITADA: estado de outro fluxo
      }
      await db.query(
        "UPDATE ai_credit_pix_charges SET status='CANCELLED',updated_at=now() WHERE id=$1 AND status='PENDING'",
        [charge.id]);
    }
  }

  // Parada LOCAL: a partir daqui nenhum fluxo gera cobrança nova. A API Pix da
  // Efí não documenta cancelamento da recorrência em si (o cliente não expõe
  // um): nada aqui alega revogar a autorização no banco do pagador — isso cabe
  // ao titular, no app do próprio banco.
  await withTenantTransaction(db, tenantId, async (client) => {
    const cancelled = (await client.query<MandateRow>(
      `UPDATE ai_credit_pix_mandates SET status='CANCELLED',cancelled_at=now(),updated_at=now()
        WHERE id=$1 AND status IN ${ACTIVE_STATUSES_SQL}
        RETURNING ${MANDATE_COLUMNS}`,
      [target.row.id])).rows[0];
    if (!cancelled) {
      // Outro stop venceu a corrida: idempotente — devolve o estado cancelado.
      const row = (await client.query<MandateRow>(
        `SELECT ${MANDATE_COLUMNS} FROM ai_credit_pix_mandates WHERE id=$1`, [target.row.id])).rows[0];
      if (row?.status === "CANCELLED") return;
      throw new Error("mandato mudou de estado durante a parada; tente novamente");
    }
    await audit(client, tenantId, actorUserId, "PIX_MANDATE_STOPPED", target.row.id, { futureCharges: target.charges.length });
  });
  return view({ ...target.row, status: "CANCELLED" }, null);
}
