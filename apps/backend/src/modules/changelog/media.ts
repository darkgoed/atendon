// F3-r1 — mídia do changelog: whitelist por magic bytes (SVG/HTML/EXE sempre fora),
// sha256, cap 10MB, multipart condicional (@fastify/multipart 9.x, Fastify 5).
import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";

export const MEDIA_MAX_BYTES = 10 * 1024 * 1024;

const signatures: Array<{ mime: string; test: (buffer: Buffer) => boolean }> = [
  { mime: "image/png", test: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/jpeg", test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", test: (b) => b.length >= 6 && (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a") },
  { mime: "image/webp", test: (b) => b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  // MP4/MOV moderno: "ftyp" em offset 4 (brand em seguida).
  { mime: "video/mp4", test: (b) => b.length >= 12 && b.subarray(4, 8).toString("latin1") === "ftyp" }
];

export function sniffMediaMime(buffer: Buffer): string | null {
  for (const signature of signatures) {
    if (signature.test(buffer)) return signature.mime;
  }
  return null;
}

export function sha256Of(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export class MediaError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface ProcessedMedia {
  buffer: Buffer;
  declaredMime: string | null;
  sniffedMime: string;
  sha256: string;
}

export interface UploadedPart {
  mimetype: string;
  file: NodeJS.ReadableStream;
  fields: Record<string, unknown>;
}

// Lê o stream do campo com cap defensivo (o limite do plugin também aplica).
export async function readMediaFile(file: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of file) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += piece.length;
    if (size > MEDIA_MAX_BYTES) {
      throw new MediaError(413, "Arquivo excede o limite de 10MB");
    }
    chunks.push(piece);
  }
  if (size === 0) throw new MediaError(400, "Arquivo vazio");
  return Buffer.concat(chunks);
}

export function validateMediaMime(buffer: Buffer, declaredMime: string | null): string {
  const sniffed = sniffMediaMime(buffer);
  if (!sniffed) throw new MediaError(415, "Tipo de arquivo não permitido (whitelist por assinatura)");
  if (declaredMime && declaredMime !== "application/octet-stream" && declaredMime !== sniffed) {
    throw new MediaError(415, "Content-type declarado diverge do conteúdo (spoof rejeitado)");
  }
  return sniffed;
}

export function mediaAltFromFields(fields: Record<string, unknown>): string | null {
  const value = fields.alt;
  if (typeof value !== "string") return null;
  const alt = value.trim().slice(0, 300);
  return alt === "" ? null : alt;
}

export function mediaPartOf(request: FastifyRequest): Promise<UploadedPart | undefined> {
  // Typed via @fastify/multipart runtime decoration; cast local para evitar acoplamento de tipos.
  const handler = (request as unknown as { file: (options?: unknown) => Promise<UploadedPart | undefined> }).file;
  return handler.call(request);
}
