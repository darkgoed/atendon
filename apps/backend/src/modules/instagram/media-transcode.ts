import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FFMPEG_TIMEOUT_MS = 30_000;
const FFMPEG_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** Formatos que a Meta aceita em `attachment type=audio` para o Instagram
 * (documentação do Send API: aac, m4a, wav, mp4). Tudo que o navegador grava
 * fora desta lista precisa de transcodificação antes do envio. */
export const INSTAGRAM_AUDIO_SEND_MIME_TYPES = new Set([
  "audio/aac",
  "audio/mp4",
  "audio/x-m4a",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav"
]);

/** Formatos de áudio produzidos pelo gravador do painel que o Instagram NÃO
 * aceita: Chrome/Edge gravam WebM/Opus e Firefox grava OGG/Opus
 * (conversation-composer.tsx). Sem transcodificação, todo envio de nota de
 * voz do atendente falha no Instagram. */
const AUDIO_MIME_TYPES_NEEDING_TRANSCODE = new Set([
  "audio/webm",
  "audio/ogg"
]);

// O Send API do Instagram aceita somente png/jpeg em `type=image`; WebP é
// recusado ("Meta rejeitou a mensagem"). GIF passa direto: a documentação do
// Attachment Upload aceita GIFs como imagem ("which include GIFs").
const IMAGE_MIME_TYPES_NEEDING_TRANSCODE = new Set([
  "image/webp"
]);

export type InstagramSendPreparation = {
  bytes: Buffer;
  contentType: string;
  transcoded: boolean;
};

/**
 * Normaliza mídia de saída para o formato que o Send API do Instagram
 * aceita, usando o ffmpeg já presente na imagem da API
 * (deploy/docker/api.Dockerfile). Best effort: se o binário não existir ou
 * a conversão falhar, os bytes originais seguem — o erro real da Meta
 * (agora propagado com o motivo) será mais diagnóstico do que um erro local
 * genérico. Nunca lança.
 */
export async function prepareInstagramOutboundMedia(input: {
  mediaType: "image" | "audio" | "video" | "file";
  mimeType: string;
  bytes: Buffer;
}): Promise<InstagramSendPreparation> {
  const mimeType = input.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const needsTranscode = input.mediaType === "audio"
    ? AUDIO_MIME_TYPES_NEEDING_TRANSCODE.has(mimeType)
    : input.mediaType === "image"
      ? IMAGE_MIME_TYPES_NEEDING_TRANSCODE.has(mimeType)
      : false;
  if (!needsTranscode || input.bytes.length === 0) {
    return { bytes: input.bytes, contentType: mimeType, transcoded: false };
  }
  const target = input.mediaType === "audio"
    ? { contentType: "audio/mp4", extension: "m4a", codecArgs: ["-c:a", "aac", "-b:a", "64k", "-vn"] }
    : { contentType: "image/png", extension: "png", codecArgs: [] };
  const workdir = tmpdir();
  const token = randomUUID();
  const inputPath = join(workdir, `atendon-ig-in-${token}.${mimeType.split("/")[1] ?? "bin"}`);
  const outputPath = join(workdir, `atendon-ig-out-${token}.${target.extension}`);
  try {
    await writeFile(inputPath, input.bytes, { mode: 0o600 });
    await execFileAsync(
      "ffmpeg",
      [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", inputPath,
        ...target.codecArgs,
        "-f", target.extension === "m4a" ? "mp4" : "image2",
        "-y", outputPath
      ],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: FFMPEG_MAX_BUFFER_BYTES }
    );
    const transcoded = await readFile(outputPath);
    if (!transcoded.length) throw new Error("ffmpeg produced no output");
    return { bytes: transcoded, contentType: target.contentType, transcoded: true };
  } catch {
    // Sem ffmpeg, binário ausente ou entrada que o ffmpeg não decodifica:
    // envia o original (o motivo da Meta é diagnóstico; falhar aqui com erro
    // genérico esconderia o problema real).
    return { bytes: input.bytes, contentType: mimeType, transcoded: false };
  } finally {
    await Promise.all([
      rm(inputPath, { force: true }),
      rm(outputPath, { force: true })
    ]).catch(() => undefined);
  }
}
