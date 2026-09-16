import { createHash } from "node:crypto";
import type { MediaType } from "./types.js";

const MAX_BYTES: Record<MediaType, number> = {
  audio: 16 * 1024 * 1024,
  image: 16 * 1024 * 1024,
  video: 25 * 1024 * 1024,
  document: 32 * 1024 * 1024
};

const ALLOWED_MIME_TYPES: Record<MediaType, Set<string>> = {
  audio: new Set(["audio/aac", "audio/flac", "audio/m4a", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/opus", "audio/wav", "audio/webm", "audio/x-m4a", "audio/x-wav"]),
  image: new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]),
  video: new Set(["video/mp4", "video/ogg", "video/quicktime", "video/webm"]),
  document: new Set([
    "application/msword",
    "application/octet-stream",
    "application/pdf",
    "application/rtf",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/vnd.oasis.opendocument.presentation",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/csv",
    "text/plain"
  ])
};

export interface OutboundMediaInput {
  mediaType: MediaType;
  mimeType: string;
  fileName: string;
  dataBase64: string;
}

export interface DecodedOutboundMedia {
  mediaType: MediaType;
  mimeType: string;
  fileName: string;
  dataBase64: string;
  sizeBytes: number;
  contentFingerprint: string;
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export function decodeOutboundMedia(input: OutboundMediaInput): DecodedOutboundMedia {
  const mimeType = input.mimeType.split(";")[0].trim().toLowerCase() || "application/octet-stream";
  if (!ALLOWED_MIME_TYPES[input.mediaType].has(mimeType)) {
    throw badRequest(`Formato de ${input.mediaType} não permitido: ${mimeType}`);
  }

  const dataBase64 = input.dataBase64.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
  const maximum = MAX_BYTES[input.mediaType];
  if (!dataBase64 || !/^[a-z0-9+/]*={0,2}$/i.test(dataBase64)) throw badRequest("Arquivo em base64 inválido");
  if (dataBase64.length > Math.ceil(maximum / 3) * 4 + 4) throw badRequest("Arquivo excede o limite permitido");

  const bytes = Buffer.from(dataBase64, "base64");
  if (!bytes.length) throw badRequest("O arquivo está vazio");
  if (bytes.length > maximum) throw badRequest(`Arquivo excede o limite de ${Math.round(maximum / 1024 / 1024)} MB`);

  const fileName = input.fileName
    .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || `arquivo-${Date.now()}`;

  return {
    mediaType: input.mediaType,
    mimeType,
    fileName,
    dataBase64: bytes.toString("base64"),
    sizeBytes: bytes.length,
    contentFingerprint: createHash("sha256").update(bytes).digest("hex")
  };
}

export function safeMediaResponseMime(mediaType: MediaType, providerMimeType: string): string {
  const mimeType = providerMimeType.split(";")[0].trim().toLowerCase();
  return ALLOWED_MIME_TYPES[mediaType].has(mimeType) ? mimeType : "application/octet-stream";
}
