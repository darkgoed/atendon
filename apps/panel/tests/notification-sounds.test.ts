import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SOUND_KEY,
  NOTIFICATION_SOUNDS,
  gainFromVolume,
  playNotificationSound,
  resolveSoundKey
} from "@/lib/notification-sounds";

const { createAudioContextMock } = vi.hoisted(() => ({ createAudioContextMock: vi.fn() }));

vi.mock("@/lib/compat", () => ({
  createAudioContext: createAudioContextMock
}));

function fakeContext() {
  const gainNode = {
    gain: {
      value: 1,
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn()
    },
    connect: vi.fn()
  };
  const oscillators: Array<{ type: string; frequency: { value: number }; connect: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  const context = {
    state: "running",
    currentTime: 0,
    destination: {},
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    createGain: vi.fn(() => gainNode),
    createOscillator: vi.fn(() => {
      const oscillator = {
        type: "sine",
        frequency: { value: 0 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn()
      };
      oscillators.push(oscillator);
      return oscillator;
    })
  };
  return { context, gainNode, oscillators };
}

beforeEach(() => {
  createAudioContextMock.mockReset();
});

describe("notification sounds (Web Audio sintetizado, sem arquivos)", () => {
  it("expõe entre 3 e 5 tons com chaves únicas e um padrão conhecido", () => {
    expect(NOTIFICATION_SOUNDS.length).toBeGreaterThanOrEqual(3);
    expect(NOTIFICATION_SOUNDS.length).toBeLessThanOrEqual(5);
    const keys = NOTIFICATION_SOUNDS.map((sound) => sound.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(DEFAULT_SOUND_KEY);
  });

  it("resolve sound_key nulo/desconhecido para o tom padrão", () => {
    expect(resolveSoundKey(null)).toBe(DEFAULT_SOUND_KEY);
    expect(resolveSoundKey(undefined)).toBe(DEFAULT_SOUND_KEY);
    expect(resolveSoundKey("inexistente")).toBe(DEFAULT_SOUND_KEY);
    expect(resolveSoundKey(NOTIFICATION_SOUNDS[1].key)).toBe(NOTIFICATION_SOUNDS[1].key);
  });

  it("mapeia volume 0-100 para ganho 0-1 com clamp e default 0.5", () => {
    expect(gainFromVolume(0)).toBe(0);
    expect(gainFromVolume(50)).toBe(0.5);
    expect(gainFromVolume(100)).toBe(1);
    expect(gainFromVolume(150)).toBe(1);
    expect(gainFromVolume(-5)).toBe(0);
    expect(gainFromVolume(null)).toBe(0.5);
    expect(gainFromVolume(undefined)).toBe(0.5);
    expect(gainFromVolume(Number.NaN)).toBe(0.5);
  });

  it("agenda osciladores com envelope e encerra o contexto", () => {
    const { context, gainNode, oscillators } = fakeContext();
    createAudioContextMock.mockReturnValue(context);

    playNotificationSound("double", 60);

    expect(context.createGain).toHaveBeenCalled();
    expect(gainNode.gain.value).toBeCloseTo(0.6);
    expect(oscillators).toHaveLength(2);
    expect(context.close).toHaveBeenCalled();
  });

  it("não toca com volume zero e não lança sem Web Audio", () => {
    createAudioContextMock.mockReturnValue(null);
    expect(() => playNotificationSound("chime", 40)).not.toThrow();

    const { context } = fakeContext();
    createAudioContextMock.mockReturnValue(context);
    playNotificationSound("chime", 0);
    expect(context.createOscillator).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalled();
  });

  it("nunca derruba o fluxo quando o AudioContext falha", () => {
    createAudioContextMock.mockImplementation(() => {
      throw new Error("sem web audio");
    });
    expect(() => playNotificationSound("ping", 50)).not.toThrow();
  });
});