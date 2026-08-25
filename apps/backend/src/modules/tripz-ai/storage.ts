import { createHash } from "node:crypto";
import { basename } from "node:path";
import { TripzAiError, type TripzAccessScope, type TripzAttachment } from "./domain.js";
import type { TripzAttachmentBinary, TripzRepositoryPort } from "./repository.js";

export const TRIPZ_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const TRIPZ_MAX_PDF_BYTES = 20 * 1024 * 1024;
export const TRIPZ_MAX_IMAGE_PIXELS = 40_000_000;
export const TRIPZ_MAX_IMAGE_DIMENSION = 16_384;
export const TRIPZ_MAX_PDF_PAGE_HINT = 200;

export type TripzAllowedMimeType = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";

export interface TripzValidatedUpload {
  data: Buffer;
  fileName: string;
  mimeType: TripzAllowedMimeType;
  extension: "jpg" | "png" | "webp" | "pdf";
  contentHash: string;
  metadata: Record<string, unknown>;
}

export interface TripzFileStore {
  upload(scope: TripzAccessScope, input: {
    conversationId: string;
    fileName: string;
    mimeType: TripzAllowedMimeType;
    data: Buffer;
  }): Promise<{ attachment: TripzAttachment; reused: boolean }>;
  read(scope: TripzAccessScope, conversationId: string, attachmentId: string): Promise<TripzAttachmentBinary | null>;
  remove(scope: TripzAccessScope, conversationId: string, attachmentId: string): Promise<boolean>;
}

const MIME_EXTENSION: Record<TripzAllowedMimeType, readonly string[]> = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "application/pdf": ["pdf"]
};

function uploadError(code: string, message: string): TripzAiError {
  return new TripzAiError(400, code, message);
}

export function sanitizeTripzFileName(value: string): string {
  const leaf = basename(value.replaceAll("\\", "/"));
  const normalized = leaf.normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
  if (!normalized || normalized === "." || normalized === "..") {
    throw uploadError("TRIPZ_FILE_NAME_INVALID", "Nome de arquivo inválido");
  }
  if (normalized.length <= 180) return normalized;
  const dot = normalized.lastIndexOf(".");
  const suffix = dot > 0 ? normalized.slice(dot, dot + 16) : "";
  return `${normalized.slice(0, 180 - suffix.length)}${suffix}`;
}

function detectMimeType(data: Buffer): TripzAllowedMimeType | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF"
    && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (data.length >= 8 && data.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
}

function pngDimensions(data: Buffer): { width: number; height: number } | null {
  if (data.length < 24 || data.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function jpegDimensions(data: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) { offset += 1; continue; }
    const marker = data[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) return null;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return null;
    const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && length >= 7) {
      return { height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

function webpDimensions(data: Buffer): { width: number; height: number } | null {
  if (data.length < 30) return null;
  const chunk = data.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X") {
    return {
      width: 1 + data.readUIntLE(24, 3),
      height: 1 + data.readUIntLE(27, 3)
    };
  }
  if (chunk === "VP8L" && data.length >= 25 && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 " && data.length >= 30 && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
    return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

function imageDimensions(data: Buffer, mimeType: TripzAllowedMimeType) {
  if (mimeType === "image/png") return pngDimensions(data);
  if (mimeType === "image/jpeg") return jpegDimensions(data);
  if (mimeType === "image/webp") return webpDimensions(data);
  return null;
}

function validateDimensions(dimensions: { width: number; height: number } | null): Record<string, unknown> {
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    throw uploadError("TRIPZ_IMAGE_INVALID", "Não foi possível validar as dimensões da imagem");
  }
  if (dimensions.width > TRIPZ_MAX_IMAGE_DIMENSION || dimensions.height > TRIPZ_MAX_IMAGE_DIMENSION
    || dimensions.width * dimensions.height > TRIPZ_MAX_IMAGE_PIXELS) {
    throw new TripzAiError(413, "TRIPZ_IMAGE_DIMENSIONS", "A imagem excede o limite de dimensões");
  }
  return { width: dimensions.width, height: dimensions.height };
}

export function validateTripzUpload(input: {
  fileName: string;
  mimeType: TripzAllowedMimeType;
  data: Buffer;
}): TripzValidatedUpload {
  const fileName = sanitizeTripzFileName(input.fileName);
  const declaredExtension = fileName.includes(".") ? fileName.split(".").at(-1)?.toLocaleLowerCase("en-US") : undefined;
  if (!declaredExtension || !MIME_EXTENSION[input.mimeType].includes(declaredExtension)) {
    throw uploadError("TRIPZ_EXTENSION_MISMATCH", "A extensão não corresponde ao tipo do arquivo");
  }
  const data = input.data;
  if (!Buffer.isBuffer(data) || !data.length) throw uploadError("TRIPZ_FILE_EMPTY", "O arquivo está vazio");
  const detectedMimeType = detectMimeType(data);
  if (detectedMimeType !== input.mimeType) {
    throw uploadError("TRIPZ_MAGIC_BYTES_INVALID", "O conteúdo não corresponde ao tipo do arquivo");
  }
  const maxBytes = input.mimeType === "application/pdf" ? TRIPZ_MAX_PDF_BYTES : TRIPZ_MAX_IMAGE_BYTES;
  if (data.length > maxBytes) {
    throw new TripzAiError(413, "TRIPZ_FILE_SIZE", input.mimeType === "application/pdf"
      ? "O PDF deve ter no máximo 20 MB"
      : "A imagem deve ter no máximo 10 MB");
  }
  let metadata: Record<string, unknown> = {};
  if (input.mimeType === "application/pdf") {
    const pageCountHint = Math.max(1, [...data.toString("latin1").matchAll(/\/Type\s*\/Page\b/g)].length);
    if (pageCountHint > TRIPZ_MAX_PDF_PAGE_HINT) {
      throw new TripzAiError(413, "TRIPZ_PDF_PAGES", "O PDF excede o limite de 200 páginas");
    }
    metadata = { pageCountHint };
  } else {
    metadata = validateDimensions(imageDimensions(data, input.mimeType));
  }
  return {
    data,
    fileName,
    mimeType: input.mimeType,
    extension: input.mimeType === "image/jpeg" ? "jpg" : MIME_EXTENSION[input.mimeType][0] as "png" | "webp" | "pdf",
    contentHash: createHash("sha256").update(data).digest("hex"),
    metadata
  };
}

export function tripzContentDisposition(fileName: string, disposition: "inline" | "attachment" = "inline"): string {
  const safe = sanitizeTripzFileName(fileName);
  const ascii = safe.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export class PostgresTripzFileStore implements TripzFileStore {
  constructor(private readonly repository: TripzRepositoryPort) {}

  async upload(scope: TripzAccessScope, input: {
    conversationId: string;
    fileName: string;
    mimeType: TripzAllowedMimeType;
    data: Buffer;
  }): Promise<{ attachment: TripzAttachment; reused: boolean }> {
    const upload = validateTripzUpload(input);
    return this.repository.createAttachment(scope, { conversationId: input.conversationId, ...upload });
  }

  read(scope: TripzAccessScope, conversationId: string, attachmentId: string) {
    return this.repository.getAttachmentContent(scope, conversationId, attachmentId);
  }

  remove(scope: TripzAccessScope, conversationId: string, attachmentId: string) {
    return this.repository.deleteAttachment(scope, conversationId, attachmentId);
  }
}
