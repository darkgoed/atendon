import { createHash } from "node:crypto";
import type { Pool } from "pg";

export const MAX_STICKER_BYTES = 1024 * 1024;

export interface AiStickerSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  mime_type: string;
  file_name: string;
  size_bytes: number;
  source: "panel_upload" | "whatsapp_sent";
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface AiStickerAsset {
  id: string;
  name: string;
  mimeType: string;
  fileName: string;
  dataBase64: string;
}

export interface AiStickerCatalogItem {
  id: string;
  name: string;
  description: string;
  tags: string[];
  lastSentAt?: string;
}

export function decodeStickerBase64(value: string): Buffer {
  const normalized = value.replace(/^data:image\/webp;base64,/i, "").replace(/\s+/g, "");
  if (!normalized || !/^[a-z0-9+/]+={0,2}$/i.test(normalized) || normalized.length % 4 !== 0) {
    throw Object.assign(new Error("Arquivo de figurinha inválido"), { statusCode: 400 });
  }
  const data = Buffer.from(normalized, "base64");
  if (!data.length || data.length > MAX_STICKER_BYTES) {
    throw Object.assign(new Error("A figurinha deve ter no máximo 1 MB"), { statusCode: 400 });
  }
  const isWebp = data.length >= 12
    && data.subarray(0, 4).toString("ascii") === "RIFF"
    && data.subarray(8, 12).toString("ascii") === "WEBP";
  if (!isWebp) throw Object.assign(new Error("Use uma figurinha no formato WebP"), { statusCode: 400 });
  return data;
}

export class StickerRepository {
  constructor(private readonly db: Pool) {}

  async list(tenantId: string): Promise<AiStickerSummary[]> {
    const result = await this.db.query<AiStickerSummary>(
      `SELECT id,name,description,tags,mime_type,file_name,size_bytes,source,enabled,created_at,updated_at
       FROM ai_stickers WHERE tenant_id=$1 ORDER BY enabled DESC,updated_at DESC,id`,
      [tenantId]
    );
    return result.rows;
  }

  async listCatalog(tenantId: string, conversationId: string): Promise<AiStickerCatalogItem[]> {
    const result = await this.db.query<{
      id: string; name: string; description: string; tags: string[]; last_sent_at: string | null;
    }>(
      `SELECT s.id,s.name,s.description,s.tags,recent.last_sent_at
       FROM ai_stickers s
       LEFT JOIN LATERAL (
         SELECT max(created_at)::text last_sent_at FROM ai_sticker_sends
         WHERE conversation_id=$2 AND sticker_id=s.id
       ) recent ON true
       WHERE s.tenant_id=$1 AND s.enabled AND length(trim(s.description))>0
       ORDER BY recent.last_sent_at NULLS FIRST,s.updated_at DESC
       LIMIT 40`,
      [tenantId, conversationId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      tags: row.tags,
      ...(row.last_sent_at ? { lastSentAt: row.last_sent_at } : {})
    }));
  }

  async findEnabledAsset(tenantId: string, id: string): Promise<AiStickerAsset | null> {
    const result = await this.db.query<{
      id: string; name: string; mime_type: string; file_name: string; media_data: Buffer;
    }>(
      `SELECT id,name,mime_type,file_name,media_data FROM ai_stickers
       WHERE tenant_id=$1 AND id=$2 AND enabled`,
      [tenantId, id]
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      name: row.name,
      mimeType: row.mime_type,
      fileName: row.file_name,
      dataBase64: row.media_data.toString("base64")
    } : null;
  }

  async createUpload(input: {
    tenantId: string; userId: string; name: string; description: string; tags: string[];
    fileName: string; data: Buffer;
  }): Promise<AiStickerSummary> {
    const hash = createHash("sha256").update(input.data).digest("hex");
    const result = await this.db.query<AiStickerSummary>(
      `INSERT INTO ai_stickers
         (tenant_id,name,description,tags,mime_type,file_name,size_bytes,content_hash,media_data,source,enabled,created_by_user_id)
       VALUES($1,$2,$3,$4,'image/webp',$5,$6,$7,$8,'panel_upload',true,$9)
       ON CONFLICT(tenant_id,content_hash) DO UPDATE SET
         name=EXCLUDED.name,description=EXCLUDED.description,tags=EXCLUDED.tags,
         file_name=EXCLUDED.file_name,enabled=true,updated_at=now()
       RETURNING id,name,description,tags,mime_type,file_name,size_bytes,source,enabled,created_at,updated_at`,
      [input.tenantId, input.name, input.description, input.tags, input.fileName, input.data.length, hash, input.data, input.userId]
    );
    return result.rows[0];
  }

  async importWhatsAppSticker(input: {
    tenantId: string; sessionId: string; externalId: string; dataBase64: string;
  }): Promise<void> {
    const data = decodeStickerBase64(input.dataBase64);
    const hash = createHash("sha256").update(data).digest("hex");
    await this.db.query(
      `INSERT INTO ai_stickers
         (tenant_id,name,description,mime_type,file_name,size_bytes,content_hash,media_data,source,
          source_session_id,source_external_id,enabled)
       VALUES($1,'Figurinha importada do WhatsApp','','image/webp',$3,$4,$5,$6,'whatsapp_sent',$2,$7,false)
       ON CONFLICT(tenant_id,content_hash) DO UPDATE SET
         source_session_id=COALESCE(ai_stickers.source_session_id,EXCLUDED.source_session_id),
         source_external_id=COALESCE(ai_stickers.source_external_id,EXCLUDED.source_external_id),
         updated_at=now()`,
      [input.tenantId, input.sessionId, `whatsapp-${input.externalId}.webp`, data.length, hash, data, input.externalId]
    );
  }

  async update(input: {
    tenantId: string; id: string; name?: string; description?: string; tags?: string[]; enabled?: boolean;
  }): Promise<AiStickerSummary | null> {
    const result = await this.db.query<AiStickerSummary>(
      `UPDATE ai_stickers SET
         name=COALESCE($3,name),description=COALESCE($4,description),tags=COALESCE($5,tags),
         enabled=COALESCE($6,enabled),updated_at=now()
       WHERE tenant_id=$1 AND id=$2
         AND (NOT COALESCE($6,false) OR length(trim(COALESCE($4,description)))>0)
       RETURNING id,name,description,tags,mime_type,file_name,size_bytes,source,enabled,created_at,updated_at`,
      [input.tenantId, input.id, input.name ?? null, input.description ?? null, input.tags ?? null, input.enabled ?? null]
    );
    return result.rows[0] ?? null;
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const result = await this.db.query("DELETE FROM ai_stickers WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
    return (result.rowCount ?? 0) > 0;
  }

  async content(tenantId: string, id: string): Promise<{ data: Buffer; mimeType: string } | null> {
    const result = await this.db.query<{ media_data: Buffer; mime_type: string }>(
      "SELECT media_data,mime_type FROM ai_stickers WHERE tenant_id=$1 AND id=$2",
      [tenantId, id]
    );
    const row = result.rows[0];
    return row ? { data: row.media_data, mimeType: row.mime_type } : null;
  }

  async recordSend(input: {
    tenantId: string; conversationId: string; stickerId: string; externalId: string;
  }): Promise<void> {
    await this.db.query(
      `WITH target AS (
         SELECT c.id conversation_id,c.session_id,s.id sticker_id,s.mime_type,s.size_bytes
         FROM conversations c
         JOIN ai_stickers s ON s.id=$3 AND s.tenant_id=$1
         WHERE c.id=$2 AND c.tenant_id=$1
       ), logged AS (
         INSERT INTO ai_sticker_sends(tenant_id,conversation_id,sticker_id,external_message_id)
         SELECT $1,conversation_id,sticker_id,$4 FROM target
         ON CONFLICT(tenant_id,external_message_id) DO NOTHING
         RETURNING conversation_id
       ), recorded AS (
         INSERT INTO messages(
           conversation_id,sender,content,media_type,external_message_id,provider_message_key,
           media_mime_type,media_file_name,media_size_bytes,media_is_sticker
         )
         SELECT conversation_id,'agent','','image',$4,$1 || ':' || session_id || ':' || $4,
                mime_type,NULL,size_bytes,true
         FROM target
         ON CONFLICT(provider_message_key) DO NOTHING
         RETURNING conversation_id
       )
       UPDATE conversations SET last_message_at=now()
       WHERE id IN (SELECT conversation_id FROM recorded)`,
      [input.tenantId, input.conversationId, input.stickerId, input.externalId]
    );
  }
}
