import { describe, expect, it } from "vitest";
import { formatRecordingDate, formatRecordingSize, normalizeMeetOrigin, recordingCanPlay } from "../lib/meet";

describe("AtendON Meet panel helpers", () => {
  it("normalizes host and URL responses without accepting insecure remote origins", () => {
    expect(normalizeMeetOrigin("meet.atendon.alpdash.com.br")).toBe("https://meet.atendon.alpdash.com.br");
    expect(normalizeMeetOrigin("https://meet.example.test/path?q=1")).toBe("https://meet.example.test");
    expect(normalizeMeetOrigin("http://localhost:8444")).toBe("http://localhost:8444");
    expect(() => normalizeMeetOrigin("http://meet.example.test")).toThrow(/conexão segura/i);
    expect(() => normalizeMeetOrigin(" ")).toThrow(/não foi informado/i);
  });

  it("formats recording sizes and gates transient or unavailable states", () => {
    expect(formatRecordingSize(0)).toBe("Tamanho indisponível");
    expect(formatRecordingSize(1_572_864)).toBe("1,5 MB");
    expect(recordingCanPlay("ready")).toBe(true);
    expect(recordingCanPlay("completed")).toBe(false);
    expect(recordingCanPlay("missing")).toBe(false);
    expect(recordingCanPlay("processing")).toBe(false);
    expect(recordingCanPlay("failed")).toBe(false);
    expect(formatRecordingDate(null, "UTC")).toBe("Data indisponível");
    expect(formatRecordingDate("invalid", "UTC")).toBe("Data indisponível");
  });
});
