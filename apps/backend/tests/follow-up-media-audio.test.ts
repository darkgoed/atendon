import { describe, expect, it } from "vitest";
import { decodeFollowUpMedia, decodeFollowUpImage, isOggOpus } from "../src/modules/messages/follow-up-media.js";

// Cabeçalhos mínimos reais de cada container, para exercitar a checagem de
// magic bytes em vez de confiar no mimeType declarado pelo cliente.
const oggOpus = () => {
  const head = Buffer.alloc(64);
  head.write("OggS", 0, "ascii");
  head.write("OpusHead", 28, "ascii");
  return head;
};
const oggVorbis = () => {
  const head = Buffer.alloc(64);
  head.write("OggS", 0, "ascii");
  head.write("vorbis", 29, "ascii");
  return head;
};
const mp3Id3 = () => {
  const head = Buffer.alloc(32);
  head.write("ID3", 0, "ascii");
  return head;
};
const mp3FrameSync = () => Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]);
const mp4 = () => {
  const head = Buffer.alloc(32);
  head.write("ftyp", 4, "ascii");
  head.write("isom", 8, "ascii");
  return head;
};
const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

const asInput = (mimeType: string, data: Buffer, fileName = "asset.bin") => ({
  mimeType,
  fileName,
  dataBase64: data.toString("base64")
});

describe("follow-up media: aceitação de áudio e vídeo", () => {
  it("aceita OGG anexado ao follow-up", () => {
    const result = decodeFollowUpMedia(asInput("audio/ogg", oggOpus(), "voz.ogg"));
    expect(result.mimeType).toBe("audio/ogg");
  });

  it("aceita MP3 com tag ID3 e com frame sync", () => {
    expect(decodeFollowUpMedia(asInput("audio/mpeg", mp3Id3(), "a.mp3")).mimeType).toBe("audio/mpeg");
    expect(decodeFollowUpMedia(asInput("audio/mpeg", mp3FrameSync(), "b.mp3")).mimeType).toBe("audio/mpeg");
  });

  it("aceita MP4", () => {
    expect(decodeFollowUpMedia(asInput("video/mp4", mp4(), "v.mp4")).mimeType).toBe("video/mp4");
  });

  it("continua aceitando imagem", () => {
    expect(decodeFollowUpMedia(asInput("image/jpeg", jpeg(), "f.jpg")).mimeType).toBe("image/jpeg");
  });
});

describe("follow-up media: conteúdo precisa bater com o formato declarado", () => {
  it("rejeita MP3 renomeado como OGG", () => {
    expect(() => decodeFollowUpMedia(asInput("audio/ogg", mp3Id3(), "falso.ogg"))).toThrow();
  });

  it("rejeita payload arbitrário declarado como áudio", () => {
    const lixo = Buffer.from("isto nao e audio nenhum", "utf8");
    expect(() => decodeFollowUpMedia(asInput("audio/mpeg", lixo, "x.mp3"))).toThrow();
  });

  it("rejeita imagem declarada como vídeo", () => {
    expect(() => decodeFollowUpMedia(asInput("video/mp4", jpeg(), "x.mp4"))).toThrow();
  });
});

describe("decodeFollowUpImage continua restrito a imagem", () => {
  it("recusa áudio mesmo com assinatura válida", () => {
    expect(() => decodeFollowUpImage(asInput("audio/ogg", oggOpus(), "voz.ogg"))).toThrow();
  });
});

describe("detecção de OGG/Opus (fast path do voice note)", () => {
  it("reconhece OGG/Opus, que dispensa conversão por ffmpeg", () => {
    expect(isOggOpus(oggOpus())).toBe(true);
  });

  it("não confunde OGG/Vorbis com Opus — esse precisa de conversão", () => {
    expect(isOggOpus(oggVorbis())).toBe(false);
  });

  it("não trata MP3 como Opus", () => {
    expect(isOggOpus(mp3Id3())).toBe(false);
  });
});
