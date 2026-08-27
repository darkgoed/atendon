import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { decodeOutboundMedia } from "./outbound-media.js";

export type FollowUpDelivery =
  | { type: "text" }
  | { type: "image"; assetId: string }
  | { type: "audio"; assetId: string }
  | { type: "video"; assetId: string }
  | { type: "sticker"; assetId: string };

export interface FollowUpMediaSummary {
  id: string;
  name: string;
  description: string;
  mime_type: "image/jpeg" | "image/png" | "image/webp" | "audio/ogg" | "audio/mpeg" | "video/mp4";
  file_name: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
}

export interface FollowUpMediaAsset {
  id: string;
  name: string;
  description: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "audio/ogg" | "audio/mpeg" | "video/mp4";
  fileName: string;
  dataBase64: string;
}

// Assinaturas (magic bytes) por formato. Não confiamos no mimeType declarado
// pelo cliente: um .mp3 renomeado para .ogg, ou um payload arbitrário com
// Content-Type forjado, seria aceito se olhássemos só a extensão/cabeçalho.
function matchesSignature(mimeType: string, data: Buffer): boolean {
  const ascii = (from: number, to: number) => data.subarray(from, to).toString("ascii");
  switch (mimeType) {
    case "image/jpeg":
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case "image/png":
      return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/webp":
      return data.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    case "audio/ogg":
      // Container OGG começa com "OggS".
      return data.length >= 4 && ascii(0, 4) === "OggS";
    case "audio/mpeg":
      // MP3 com tag ID3 ("ID3") ou frame sync MPEG (0xFF Ex/Fx).
      return data.length >= 3
        && (ascii(0, 3) === "ID3" || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0));
    case "video/mp4":
      // Box ftyp nos bytes 4..8 do container ISO-BMFF.
      return data.length >= 12 && ascii(4, 8) === "ftyp";
    default:
      return false;
  }
}

/** Sinaliza que o OGG recebido usa Opus — o codec nativo de voice note do WhatsApp. */
export function isOggOpus(data: Buffer): boolean {
  if (data.length < 4 || data.subarray(0, 4).toString("ascii") !== "OggS") return false;
  // "OpusHead" aparece no primeiro pacote do fluxo; procuramos no início do arquivo.
  return data.subarray(0, Math.min(data.length, 512)).includes(Buffer.from("OpusHead", "ascii"));
}

export function decodeFollowUpMedia(input: {
  mimeType: string;
  fileName: string;
  dataBase64: string;
}): { mimeType: FollowUpMediaAsset["mimeType"]; fileName: string; data: Buffer } {
  const declared = input.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const data = Buffer.from(input.dataBase64, "base64");
  if (!matchesSignature(declared, data)) {
    throw Object.assign(
      new Error("O conteúdo do arquivo não corresponde ao formato declarado"),
      { statusCode: 400 }
    );
  }
  // MediaType do gateway cobre audio/image/document — não há "video". Por isso
  // vídeo é validado aqui (assinatura + tamanho) em vez de passar por
  // decodeOutboundMedia, que rejeitaria video/mp4 como documento não permitido.
  if (declared === "video/mp4") {
    const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
    if (data.length > MAX_VIDEO_BYTES) {
      throw Object.assign(new Error("Vídeo excede o tamanho máximo permitido"), { statusCode: 400 });
    }
    return { mimeType: "video/mp4", fileName: input.fileName.trim(), data };
  }
  const decoded = decodeOutboundMedia({
    mediaType: declared.startsWith("audio/") ? "audio" : "image",
    ...input
  });
  return {
    mimeType: declared as FollowUpMediaAsset["mimeType"],
    fileName: decoded.fileName,
    data
  };
}

/** Mantido para compatibilidade com chamadas existentes que só aceitam imagem. */
export function decodeFollowUpImage(input: {
  mimeType: string;
  fileName: string;
  dataBase64: string;
}): { mimeType: FollowUpMediaAsset["mimeType"]; fileName: string; data: Buffer } {
  const declared = input.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!declared.startsWith("image/")) {
    throw Object.assign(new Error("Formato de imagem não suportado"), { statusCode: 400 });
  }
  return decodeFollowUpMedia(input);
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
         WHERE tenant_id=$1 AND (
           ai_follow_up_delivery @> $2::jsonb
           OR ai_follow_up_delivery @> $3::jsonb
           OR ai_follow_up_delivery @> $4::jsonb
         )
       ) used`,
      [tenantId, JSON.stringify([{ type: "image", assetId: id }]),
        JSON.stringify([{ type: "audio", assetId: id }]),
        JSON.stringify([{ type: "video", assetId: id }])]
    );
    if (used.rows[0]?.used) return "in_use";
    const result = await this.db.query(
      "DELETE FROM ai_follow_up_media_assets WHERE tenant_id=$1 AND id=$2",
      [tenantId, id]
    );
    return result.rowCount ? "removed" : "missing";
  }

  async validateDelivery(tenantId: string, delivery: FollowUpDelivery[]): Promise<void> {
    const mediaIds = delivery.filter((item) => item.type === "image" || item.type === "audio" || item.type === "video").map((item) => item.assetId);
    const stickerIds = delivery.filter((item) => item.type === "sticker").map((item) => item.assetId);
    const [media, stickers] = await Promise.all([
      mediaIds.length
        ? this.db.query<{ id: string }>(
          "SELECT id FROM ai_follow_up_media_assets WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
          [tenantId, mediaIds]
        )
        : Promise.resolve({ rows: [] as Array<{ id: string }> }),
      stickerIds.length
        ? this.db.query<{ id: string }>(
          "SELECT id FROM ai_stickers WHERE tenant_id=$1 AND enabled AND id=ANY($2::uuid[])",
          [tenantId, stickerIds]
        )
        : Promise.resolve({ rows: [] as Array<{ id: string }> })
    ]);
    if (media.rows.length !== new Set(mediaIds).size) {
      throw Object.assign(new Error("Uma das mídias selecionadas não está mais disponível"), { statusCode: 400 });
    }
    if (stickers.rows.length !== new Set(stickerIds).size) {
      throw Object.assign(new Error("Uma das figurinhas selecionadas não está ativa ou não existe"), { statusCode: 400 });
    }
  }
}
