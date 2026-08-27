import { parseIdempotencyKey, payloadFingerprint } from "./idempotency.js";

export type FollowUpDb = { query: <T = any>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount?: number }> };
export type FollowUpResult = { externalId: string; messageId: string | null };

export async function enqueueFollowUpOnce(
  db: FollowUpDb,
  input: { tenantId: string; conversationId: string; idempotencyKey: string },
  operation: () => Promise<FollowUpResult>
): Promise<{ requestId: string; duplicate: boolean; status: string; result?: FollowUpResult }> {
  const key = parseIdempotencyKey(input.idempotencyKey);
  const hash = payloadFingerprint({ conversationId: input.conversationId });
  const claimed = await db.query<{ id: string }>(
    `INSERT INTO outbound_message_requests(tenant_id,conversation_id,idempotency_key,request_hash)
     SELECT $1,c.id,$3,$4 FROM conversations c WHERE c.id=$2 AND c.tenant_id=$1
     ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING id`,
    [input.tenantId, input.conversationId, key, hash]
  );
  const requestId = claimed.rows[0]?.id;
  if (!requestId) {
    const previous = await db.query<{ id: string; request_hash: string; status: string; external_message_id: string | null }>(
      `SELECT id,request_hash,status,external_message_id FROM outbound_message_requests WHERE tenant_id=$1 AND idempotency_key=$2`, [input.tenantId, key]
    );
    const row = previous.rows[0];
    if (!row) throw new Error("Conversation does not belong to tenant");
    if (row.request_hash.trim() !== hash) throw Object.assign(new Error("Idempotency-Key já foi usada com outro conteúdo"), { statusCode: 409 });
    return { requestId: row.id, duplicate: true, status: row.status, ...(row.external_message_id ? { result: { externalId: row.external_message_id, messageId: null } } : {}) };
  }
  setImmediate(() => void operation().then(async (result) => {
    await db.query(`UPDATE outbound_message_requests SET status='sent',external_message_id=$3,error_message=NULL,completed_at=now() WHERE tenant_id=$1 AND idempotency_key=$2 AND status='pending'`, [input.tenantId, key, result.externalId]);
  }).catch(async (error) => {
    await db.query(`UPDATE outbound_message_requests SET status='failed',error_message=$3,completed_at=now() WHERE tenant_id=$1 AND idempotency_key=$2 AND status='pending'`, [input.tenantId, key, error instanceof Error ? error.message : String(error)]);
  }));
  return { requestId, duplicate: false, status: "pending" };
}

export async function runFollowUpOnce(
  db: FollowUpDb,
  input: { tenantId: string; conversationId: string; idempotencyKey: string },
  operation: () => Promise<FollowUpResult>,
  waitMs = 100,
  attempts = 30
): Promise<{ result: FollowUpResult; duplicate: boolean }> {
  const key = parseIdempotencyKey(input.idempotencyKey);
  const hash = payloadFingerprint({ conversationId: input.conversationId });
  const claimed = await db.query<{ id: string }>(
    `INSERT INTO outbound_message_requests(tenant_id,conversation_id,idempotency_key,request_hash)
     SELECT $1,c.id,$3,$4 FROM conversations c WHERE c.id=$2 AND c.tenant_id=$1
     ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING id`,
    [input.tenantId, input.conversationId, key, hash]
  );
  if (!claimed.rows[0]) {
    for (let i = 0; i < attempts; i += 1) {
      const previous = await db.query<{ request_hash: string; status: string; external_message_id: string | null }>(
        `SELECT request_hash,status,external_message_id FROM outbound_message_requests WHERE tenant_id=$1 AND idempotency_key=$2`,
        [input.tenantId, key]
      );
      const row = previous.rows[0];
      if (!row) throw new Error("Conversation does not belong to tenant");
      if (row.request_hash.trim() !== hash) {
        const error = new Error("Idempotency-Key já foi usada com outro conteúdo");
        (error as Error & { statusCode?: number }).statusCode = 409;
        throw error;
      }
      if (row.status === "sent" && row.external_message_id) {
        const message = await db.query<{ id: string }>(
          `SELECT id FROM messages
           WHERE tenant_id=$1 AND conversation_id=$2 AND external_message_id=$3
           ORDER BY created_at DESC LIMIT 1`,
          [input.tenantId, input.conversationId, row.external_message_id]
        );
        return { result: { externalId: row.external_message_id, messageId: message.rows[0]?.id ?? null }, duplicate: true };
      }
      if (row.status === "failed") throw new Error("Envio anterior falhou");
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    const error = new Error("Envio com esta Idempotency-Key ainda está em andamento");
    (error as Error & { statusCode?: number }).statusCode = 409;
    throw error;
  }
  try {
    const result = await operation();
    await db.query(
      `UPDATE outbound_message_requests SET status='sent',external_message_id=$3,error_message=NULL,completed_at=now() WHERE tenant_id=$1 AND idempotency_key=$2 AND status='pending'`,
      [input.tenantId, key, result.externalId]
    );
    return { result, duplicate: false };
  } catch (error) {
    await db.query(
      `UPDATE outbound_message_requests SET status='failed',error_message=$3,completed_at=now() WHERE tenant_id=$1 AND idempotency_key=$2 AND status='pending'`,
      [input.tenantId, key, error instanceof Error ? error.message : String(error)]
    );
    throw error;
  }
}
