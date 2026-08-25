import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { decodeOutboundMedia } from "./outbound-media.js";

export type FollowUpDelivery =
  | { type: "text" }
  | { type: "image"; assetId: string }
  | { type: "sticker"; assetId: string };

export interface FollowUpMediaSummary {
  id: string;
  name: string;
  description: string;
  mime_type: "image/jpeg" | "image/png" | "image/webp";
  file_name: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
}

export interface FollowUpMediaAsset {
  id: string;
  name: string;
  description: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  fileName: string;
  dataBase64: string;
}

export function decodeFollowUpImage(input: {
  mimeType: string;
  fileName: string;
  dataBase64: string;
}): { mimeType: FollowUpMediaAsset["mimeType"]; fileName: string; data: Buffer } {
  const decoded = decodeOutboundMedia({ mediaType: "image", ...input });
  const data = Buffer.from(decoded.dataBase64, "base64");
  const isJpeg = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const isPng = data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = data.length >= 12
    && data.subarray(0, 4).toString("ascii") === "RIFF"
    && data.subarray(8, 12).toString("ascii") === "WEBP";
  const validSignature = decoded.mimeType === "image/jpeg" ? isJpeg
    : decoded.mimeType === "image/png" ? isPng
      : decoded.mimeType === "image/webp" ? isWebp : false;
  if (!validSignature) {
    throw Object.assign(new Error("O conteúdo do arquivo não corresponde ao formato da imagem"), { statusCode: 400 });
  }
  return {
    mimeType: decoded.mimeType as FollowUpMediaAsset["mimeType"],
    fileName: decoded.fileName,
    data
  };
}

export class FollowUpMediaRepository {
  constructor(private readonly db: Pool) {}

  async list(tenantId: string): Promise<FollowUpMediaSummary[]> {
    const result = await this.db.query<FollowUpMediaSummary>(
      `SELECT id,name,description,mime_type,file_name,size_bytes,created_at,updated_at
       FROM ai_follow_up_media_assets WHERE tenant_id=$1 ORDER BY updated_at DESC,id`,
      [tenantId]
    );
    return result.rows;
  }

  async create(input: {
    tenantId: string;
    userId: string;
    name: string;
    description: string;
    mimeType: FollowUpMediaAsset["mimeType"];
    fileName: string;
    data: Buffer;
  }): Promise<FollowUpMediaSummary> {
    const hash = createHash("sha256").update(input.data).digest("hex");
    const result = await this.db.query<FollowUpMediaSummary>(
      `INSERT INTO ai_follow_up_media_assets
         (tenant_id,name,description,mime_type,file_name,size_bytes,content_hash,media_data,created_by_user_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(tenant_id,content_hash) DO UPDATE SET
         name=EXCLUDED.name,description=EXCLUDED.description,file_name=EXCLUDED.file_name,updated_at=now()
       RETURNING id,name,description,mime_type,file_name,size_bytes,created_at,updated_at`,
      [input.tenantId, input.name, input.description, input.mimeType, input.fileName, input.data.length,
        hash, input.data, input.userId]
    );
    return result.rows[0];
  }

  async find(tenantId: string, id: string): Promise<FollowUpMediaAsset | null> {
    const result = await this.db.query<{
      id: string;
      name: string;
      description: string;
      mime_type: FollowUpMediaAsset["mimeType"];
      file_name: string;
      media_data: Buffer;
    }>(
      `SELECT id,name,description,mime_type,file_name,media_data
       FROM ai_follow_up_media_assets WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id]
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      name: row.name,
      description: row.description,
      mimeType: row.mime_type,
      fileName: row.file_name,
      dataBase64: row.media_data.toString("base64")
    } : null;
  }

  async content(tenantId: string, id: string): Promise<{ data: Buffer; mimeType: string } | null> {
    const result = await this.db.query<{ media_data: Buffer; mime_type: string }>(
      "SELECT media_data,mime_type FROM ai_follow_up_media_assets WHERE tenant_id=$1 AND id=$2",
      [tenantId, id]
    );
    const row = result.rows[0];
    return row ? { data: row.media_data, mimeType: row.mime_type } : null;
  }

  async remove(tenantId: string, id: string): Promise<"removed" | "in_use" | "missing"> {
    const used = await this.db.query<{ used: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM tenant_ai_settings
         WHERE tenant_id=$1 AND ai_follow_up_delivery @> $2::jsonb
       ) used`,
      [tenantId, JSON.stringify([{ type: "image", assetId: id }])]
    );
    if (used.rows[0]?.used) return "in_use";
    const result = await this.db.query(
      "DELETE FROM ai_follow_up_media_assets WHERE tenant_id=$1 AND id=$2",
      [tenantId, id]
    );
    return result.rowCount ? "removed" : "missing";
  }

  async validateDelivery(tenantId: string, delivery: FollowUpDelivery[]): Promise<void> {
    const imageIds = delivery.filter((item) => item.type === "image").map((item) => item.assetId);
    const stickerIds = delivery.filter((item) => item.type === "sticker").map((item) => item.assetId);
    const [images, stickers] = await Promise.all([
      imageIds.length
        ? this.db.query<{ id: string }>(
          "SELECT id FROM ai_follow_up_media_assets WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
          [tenantId, imageIds]
        )
        : Promise.resolve({ rows: [] as Array<{ id: string }> }),
      stickerIds.length
        ? this.db.query<{ id: string }>(
          "SELECT id FROM ai_stickers WHERE tenant_id=$1 AND enabled AND id=ANY($2::uuid[])",
          [tenantId, stickerIds]
        )
        : Promise.resolve({ rows: [] as Array<{ id: string }> })
    ]);
    if (images.rows.length !== new Set(imageIds).size) {
      throw Object.assign(new Error("Uma das imagens selecionadas não está mais disponível"), { statusCode: 400 });
    }
    if (stickers.rows.length !== new Set(stickerIds).size) {
      throw Object.assign(new Error("Uma das figurinhas selecionadas não está ativa ou não existe"), { statusCode: 400 });
    }
  }
}
