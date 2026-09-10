import type { Pool } from "pg";

export interface SessionRecord { id: string; tenantId: string; status: string; instanceName: string }

export class SessionRepository {
  constructor(private readonly db: Pool) {}

  async listRunnable(): Promise<SessionRecord[]> {
    const result = await this.db.query<{ id: string; tenant_id: string; status: string; instance_name: string | null }>(
      `SELECT s.id, s.tenant_id, s.status, s.instance_name FROM whatsapp_sessions s
       JOIN tenants t ON t.id = s.tenant_id
       WHERE t.status IN ('trial', 'active') AND s.status IN ('connected', 'qr_pending')
         AND s.archived_at IS NULL
       ORDER BY s.created_at`
    );
    return Promise.all(result.rows.map(async (row) => {
      const instanceName = row.instance_name ?? `atendon_${row.id.replaceAll("-", "")}`;
      if (!row.instance_name) await this.db.query("UPDATE whatsapp_sessions SET instance_name=$2 WHERE id=$1", [row.id, instanceName]);
      return { id: row.id, tenantId: row.tenant_id, status: row.status, instanceName };
    }));
  }

  async listByTenant(tenantId: string): Promise<Array<SessionRecord & {
    label: string; phoneNumber: string | null; isPrimary: boolean;
    qrCode: string | null; lastConnectedAt: string | null;
    disconnectedReason: string | null; createdAt: string;
  }>> {
    const result = await this.db.query(
      `SELECT id, tenant_id, status, instance_name, label, phone_number, is_primary,
              qr_code, last_connected_at, disconnected_reason, created_at
       FROM whatsapp_sessions
       WHERE tenant_id=$1 AND archived_at IS NULL
       ORDER BY is_primary DESC, created_at`, [tenantId]
    );
    return result.rows.map((row) => ({
      id: row.id, tenantId: row.tenant_id, status: row.status, instanceName: row.instance_name,
      label: row.label, phoneNumber: row.phone_number, isPrimary: row.is_primary,
      qrCode: row.qr_code, lastConnectedAt: row.last_connected_at,
      disconnectedReason: row.disconnected_reason, createdAt: row.created_at
    }));
  }

  async findByInstance(instanceName: string): Promise<{ id: string; tenantId: string; archivedAt: string | null } | null> {
    const result = await this.db.query<{ id: string; tenant_id: string; archived_at: string | null }>(
      "SELECT id, tenant_id, archived_at FROM whatsapp_sessions WHERE instance_name=$1", [instanceName]
    );
    return result.rows[0] ? {
      id: result.rows[0].id,
      tenantId: result.rows[0].tenant_id,
      archivedAt: result.rows[0].archived_at
    } : null;
  }

  /** Conexão padrão do tenant para fluxos que ainda não escolhem número. */
  async primaryId(tenantId: string): Promise<string | null> {
    const result = await this.db.query<{ id: string }>(
      `SELECT id FROM whatsapp_sessions
       WHERE tenant_id=$1 AND archived_at IS NULL
       ORDER BY is_primary DESC, created_at DESC
       LIMIT 1`, [tenantId]
    );
    return result.rows[0]?.id ?? null;
  }

  async tenantId(sessionId: string): Promise<string> {
    const result = await this.db.query<{ tenant_id: string }>("SELECT tenant_id FROM whatsapp_sessions WHERE id=$1", [sessionId]);
    if (!result.rows[0]) throw new Error(`Sessão WhatsApp não encontrada: ${sessionId}`);
    return result.rows[0].tenant_id;
  }

  async instanceName(sessionId: string): Promise<string> {
    const result = await this.db.query<{ instance_name: string }>("SELECT instance_name FROM whatsapp_sessions WHERE id=$1", [sessionId]);
    if (!result.rows[0]?.instance_name) throw new Error(`Evolution instance missing for session ${sessionId}`);
    return result.rows[0].instance_name;
  }

  async updateStatus(sessionId: string, status: "qr_pending" | "connected" | "disconnected" | "banned", phoneNumber?: string, qrCode?: string, disconnectedReason?: string): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_sessions SET status = $2,
       phone_number = COALESCE($3, phone_number),
       qr_code = CASE WHEN $2 = 'qr_pending' THEN COALESCE($4, qr_code) ELSE NULL END,
       disconnected_reason = CASE WHEN $2 = 'disconnected' THEN $5 ELSE NULL END,
       last_connected_at = CASE WHEN $2 = 'connected' THEN now() ELSE last_connected_at END
       WHERE id = $1`, [sessionId, status, phoneNumber ?? null, qrCode ?? null, disconnectedReason ?? null]
    );
  }

  async prepareReconnect(sessionId: string): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_sessions SET status='qr_pending', phone_number=NULL, qr_code=NULL,
       disconnected_reason=NULL WHERE id=$1`,
      [sessionId]
    );
  }
}
