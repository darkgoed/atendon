import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  audioDisplayName,
  formatAudioDuration,
  sampleAudioWaveform
} from "../lib/audio-waveform";

describe("audio waveform", () => {
  it("removes only the displayed audio extension", () => {
    expect(audioDisplayName("audio-2030-01-02.webm")).toBe("audio-2030-01-02");
    expect(audioDisplayName("relato.final.ogg")).toBe("relato.final");
    expect(audioDisplayName("Mensagem de áudio")).toBe("Mensagem de áudio");
    expect(audioDisplayName(null)).toBe("Mensagem de áudio");
  });

  it("formats finite durations and safely handles invalid values", () => {
    expect(formatAudioDuration(65.9)).toBe("01:05");
    expect(formatAudioDuration(Number.NaN)).toBe("00:00");
    expect(formatAudioDuration(-3)).toBe("00:00");
  });

  it("derives bar heights from the real PCM amplitude", () => {
    const channel = Float32Array.from([
      0, 0, 0, 0,
      0.08, -0.08, 0.08, -0.08,
      0.35, -0.35, 0.35, -0.35,
      0.9, -0.9, 0.9, -0.9
    ]);
    const bars = sampleAudioWaveform([channel], 4);

    expect(bars).toHaveLength(4);
    expect(bars[0]).toBe(0.08);
    expect(bars[1]).toBeLessThan(bars[2]);
    expect(bars[2]).toBeLessThan(bars[3]);
    expect(bars[3]).toBe(1);
  });

  it("integrates live analysis and decoded playback without changing the sent filename", async () => {
    const [voiceInput, composer, media] = await Promise.all([
      readFile(new URL("../components/ui/voice-input.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/conversation-composer.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/conversation-message-media.tsx", import.meta.url), "utf8")
    ]);

    expect(voiceInput).toContain("createMediaStreamSource(stream)");
    expect(voiceInput).toContain("getByteTimeDomainData");
    expect(voiceInput).toContain("decodeAudioData");
    expect(voiceInput).toContain("sampleAudioWaveform(channels)");
    expect(composer).toContain("<VoiceInput");
    expect(composer).toContain("<VoiceMessagePlayer");
    expect(composer).toContain("fileName: attachment.file.name");
    expect(media).toContain("audioDisplayName(rawFileName)");
    expect(media).toContain("<VoiceMessagePlayer");
  });
});
