import type { Pool } from "pg";

export interface SessionRecord { id: string; tenantId: string; status: string; instanceName: string }

export class SessionRepository {
  constructor(private readonly db: Pool) {}

  async listRunnable(): Promise<SessionRecord[]> {
    const result = await this.db.query<{ id: string; tenant_id: string; status: string; instance_name: string | null }>(
      `SELECT s.id, s.tenant_id, s.status, s.instance_name FROM whatsapp_sessions s
       JOIN tenants t ON t.id = s.tenant_id
       WHERE t.status IN ('trial', 'active') AND s.status IN ('connected', 'qr_pending')
       ORDER BY s.created_at`
    );
    return Promise.all(result.rows.map(async (row) => {
      const instanceName = row.instance_name ?? `atendon_${row.id.replaceAll("-", "")}`;
      if (!row.instance_name) await this.db.query("UPDATE whatsapp_sessions SET instance_name=$2 WHERE id=$1", [row.id, instanceName]);
      return { id: row.id, tenantId: row.tenant_id, status: row.status, instanceName };
    }));
  }

  async findByInstance(instanceName: string): Promise<{ id: string; tenantId: string } | null> {
    const result = await this.db.query<{ id: string; tenant_id: string }>(
      "SELECT id, tenant_id FROM whatsapp_sessions WHERE instance_name=$1", [instanceName]
    );
    return result.rows[0] ? { id: result.rows[0].id, tenantId: result.rows[0].tenant_id } : null;
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
