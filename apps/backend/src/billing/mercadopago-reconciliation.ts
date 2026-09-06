import type { Pool } from "pg";
import { db } from "../db/client.js";
import { config } from "../config.js";
import { getProvider } from "./providers/registry.js";
import type { MercadoPagoProvider } from "./providers/mercadopago.js";

export type ReconciliationFindingType = "STATUS_MISMATCH" | "AMOUNT_MISMATCH" | "CURRENCY_MISMATCH" | "REFERENCE_MISMATCH" | "GATEWAY_ERROR";
export type ReconciliationResult = { scanned: number; findings: number; errors: string[] };
export type ReconciliationDeps = { database?: Pick<Pool, "query">; getPayment?: (externalId: string) => Promise<unknown> };

type PaymentRow = { id:string; tenant_id:string; external_id:string; status:string; amount_cents:string|number; currency:string; invoice_id:string; invoice_status:string; invoice_amount_cents:string|number; invoice_currency:string; external_reference:string|null; provider_credentials:string; provider_webhook_secret:string|null };
type Remote = { status?: unknown; transaction_amount?: unknown; currency_id?: unknown; external_reference?: unknown; id?: unknown };
const safeRemote = (p: Remote) => ({ id: typeof p.id === "string" ? p.id : undefined, status: typeof p.status === "string" ? p.status : undefined, transaction_amount: typeof p.transaction_amount === "number" ? p.transaction_amount : undefined, currency_id: typeof p.currency_id === "string" ? p.currency_id : undefined, external_reference: typeof p.external_reference === "string" ? p.external_reference : undefined });
const safeLocal = (p: PaymentRow) => ({ payment_id:p.id, status:p.status, amount_cents:Number(p.amount_cents), currency:p.currency, external_reference:p.external_reference });

export async function runMercadoPagoReconciliationBatch(limit = 100, deps: ReconciliationDeps = {}): Promise<ReconciliationResult> {
  const database = deps.database ?? db;
  const result: ReconciliationResult = { scanned: 0, findings: 0, errors: [] };
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));

  // Claim atômico com lease: diferente de SELECT ... FOR UPDATE sem BEGIN, este
  // UPDATE continua protegendo depois que a instrução termina. Se o processo
  // morrer durante a chamada HTTP, a lease expira e outro worker retoma.
  const claimed = await database.query<{ id: string }>(`
    WITH candidates AS (
      SELECT p.id
      FROM payments p
      JOIN invoices i ON i.id=p.invoice_id
      JOIN billing_providers b ON b.id=COALESCE(p.provider_id,i.provider_id)
      WHERE p.external_id IS NOT NULL
        AND b.code='mercadopago'
        AND b.environment='production'
        AND b.homologated=true
        AND b.enabled=true
        AND b.status='CONNECTED'
        AND (p.reconciliation_claimed_at IS NULL OR p.reconciliation_claimed_at < now()-interval '10 minutes')
      ORDER BY p.created_at DESC,p.id DESC
      LIMIT $1
      FOR UPDATE OF p SKIP LOCKED
    )
    UPDATE payments p
       SET reconciliation_claimed_at=now()
      FROM candidates c
     WHERE p.id=c.id
     RETURNING p.id`, [boundedLimit]);
  if (!claimed.rows.length) return result;

  const candidates = await database.query<PaymentRow>(`
    SELECT p.id,p.tenant_id,p.external_id,p.status,p.amount_cents,p.currency,p.invoice_id,
           i.status invoice_status,i.amount_cents invoice_amount_cents,i.currency invoice_currency,
           COALESCE(p.metadata->>'external_reference',i.metadata->>'external_reference',i.external_id) external_reference,
           b.credentials_encrypted provider_credentials,b.webhook_secret_encrypted provider_webhook_secret
      FROM payments p
      JOIN invoices i ON i.id=p.invoice_id
      JOIN billing_providers b ON b.id=COALESCE(p.provider_id,i.provider_id)
     WHERE p.id=ANY($1::uuid[])
     ORDER BY p.created_at DESC,p.id DESC`, [claimed.rows.map((row) => row.id)]);

  for (const payment of candidates.rows) {
    result.scanned++;
    try {
      const remote = deps.getPayment
        ? await deps.getPayment(payment.external_id) as Remote
        : await (getProvider("mercadopago", { mercadopago: {
            credentialsEncrypted: payment.provider_credentials,
            webhookSecretEncrypted: payment.provider_webhook_secret ?? undefined,
            encryptionKey: config.DATA_ENCRYPTION_KEY,
            environment: "production"
          } }) as MercadoPagoProvider).getPayment(payment.external_id);
      const remoteData = ((remote as { payload?: unknown }).payload ?? remote) as Remote;
      const snapshot = safeRemote(remoteData);
      const checks: Array<[ReconciliationFindingType, boolean]> = [
        ["STATUS_MISMATCH", String(remoteData.status ?? "").toLowerCase() !== String(payment.status).toLowerCase() && String(remoteData.status ?? "").toLowerCase() !== String(payment.invoice_status).toLowerCase()],
        ["AMOUNT_MISMATCH", typeof remoteData.transaction_amount === "number" && Math.round(remoteData.transaction_amount * 100) !== Number(payment.amount_cents) && Math.round(remoteData.transaction_amount * 100) !== Number(payment.invoice_amount_cents)],
        ["CURRENCY_MISMATCH", typeof remoteData.currency_id === "string" && remoteData.currency_id !== payment.currency && remoteData.currency_id !== payment.invoice_currency],
        ["REFERENCE_MISMATCH", typeof remoteData.external_reference === "string" && payment.external_reference != null && remoteData.external_reference !== payment.external_reference]
      ];
      const activeTypes = checks.filter(([, mismatch]) => mismatch).map(([type]) => type);
      for (const [type, mismatch] of checks) {
        if (!mismatch) continue;
        await database.query(`INSERT INTO mercadopago_reconciliation_findings(tenant_id,payment_id,finding_type,severity,local_snapshot,remote_snapshot) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(payment_id,finding_type) DO UPDATE SET local_snapshot=EXCLUDED.local_snapshot,remote_snapshot=EXCLUDED.remote_snapshot,detected_at=now(),resolved_at=NULL`, [payment.tenant_id,payment.id,type,type === "STATUS_MISMATCH" ? "critical" : "warning",safeLocal(payment),snapshot]);
        result.findings++;
      }
      // Uma leitura remota bem-sucedida resolve findings que deixaram de existir
      // e também o erro de gateway anterior; nunca altera invoice/payment.
      await database.query(
        `UPDATE mercadopago_reconciliation_findings
            SET resolved_at=now()
          WHERE payment_id=$1 AND resolved_at IS NULL
            AND finding_type <> ALL($2::text[])`,
        [payment.id, activeTypes]
      );
    } catch (error) {
      result.errors.push(`payment:${payment.id}:${error instanceof Error ? error.message : "gateway error"}`);
      await database.query(`INSERT INTO mercadopago_reconciliation_findings(tenant_id,payment_id,finding_type,severity,local_snapshot,remote_snapshot) VALUES($1,$2,'GATEWAY_ERROR','critical',$3,$4) ON CONFLICT(payment_id,finding_type) DO UPDATE SET detected_at=now(),resolved_at=NULL,remote_snapshot=EXCLUDED.remote_snapshot`, [payment.tenant_id,payment.id,safeLocal(payment),{ error: "gateway_request_failed" }]);
      result.findings++;
    } finally {
      await database.query("UPDATE payments SET reconciliation_claimed_at=NULL WHERE id=$1", [payment.id]);
    }
  }
  return result;
}
