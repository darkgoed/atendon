import { createAudioContext } from "@/lib/compat";

/**
 * Tons de notificação sintetizados via Web Audio — zero arquivos de áudio.
 * O acento (envelope) é simples e curto: o som de notificação precisa ser
 * reconhecível em < 400ms e não pode deixar AudioContext aberto (limite de
 * instâncias por página em navegadores antigos).
 */

export type NotificationSoundOption = {
  key: string;
  label: string;
};

/** Opções expostas na UI (Configurações → Notificações do painel). */
export const NOTIFICATION_SOUNDS: readonly NotificationSoundOption[] = [
  { key: "ping", label: "Ping" },
  { key: "double", label: "Duplo" },
  { key: "chime", label: "Sino" },
  { key: "pulse", label: "Pulso" }
];

export const DEFAULT_SOUND_KEY = "ping";

type ToneNote = {
  frequency: number;
  /** Offset em segundos a partir do início do som. */
  start: number;
  /** Duração em segundos (decaimento até 0.001). */
  duration: number;
  type?: OscillatorType;
  gain?: number;
};

const SOUND_NOTES: Record<string, readonly ToneNote[]> = {
  ping: [
    { frequency: 880, start: 0, duration: 0.22 }
  ],
  double: [
    { frequency: 784, start: 0, duration: 0.12 },
    { frequency: 988, start: 0.16, duration: 0.18 }
  ],
  chime: [
    { frequency: 523.25, start: 0, duration: 0.42, gain: 0.8 },
    { frequency: 659.25, start: 0.09, duration: 0.42, gain: 0.7 },
    { frequency: 783.99, start: 0.18, duration: 0.5, gain: 0.6 }
  ],
  pulse: [
    { frequency: 329.63, start: 0, duration: 0.16, type: "triangle" },
    { frequency: 246.94, start: 0.2, duration: 0.22, type: "triangle" }
  ]
};

/** volume salvo em 0-100 (contrato PATCH /me/notification-preferences) → ganho 0-1. */
export function gainFromVolume(volume: number | null | undefined): number {
  if (typeof volume !== "number" || !Number.isFinite(volume)) return 0.5;
  return Math.min(1, Math.max(0, volume / 100));
}

/** Chave conhecida ou o tom padrão (sound_key pode chegar null do backend). */
export function resolveSoundKey(soundKey: string | null | undefined): string {
  return SOUND_NOTES[soundKey ?? ""] ? (soundKey as string) : DEFAULT_SOUND_KEY;
}

/**
 * Toca um tom sintetizado. Silencioso por construção: sem Web Audio
 * (createAudioContext devolve null), contexto suspenso ou falha de agenda —
 * nunca derruba o fluxo (o toast de som é opcional, não crítico).
 */
export function playNotificationSound(soundKey?: string | null, volume?: number | null): void {
  try {
    const context = createAudioContext();
    if (!context) return;
    const gain = gainFromVolume(volume);
    if (gain <= 0) {
      void closeAudioContext(context);
      return;
    }
    if (context.state === "suspended" && typeof context.resume === "function") {
      void context.resume().catch(() => undefined);
    }
    const notes = SOUND_NOTES[resolveSoundKey(soundKey)];
    if (!notes) {
      void closeAudioContext(context);
      return;
    }
    const master = context.createGain();
    master.gain.value = gain;
    master.connect(context.destination);
    const start = context.currentTime + 0.02;
    let lastEnd = start;
    for (const note of notes) {
      const oscillator = context.createOscillator();
      oscillator.type = note.type ?? "sine";
      oscillator.frequency.value = note.frequency;
      const envelope = context.createGain();
      envelope.gain.setValueAtTime(0.0001, start + note.start);
      envelope.gain.linearRampToValueAtTime(note.gain ?? 1, start + note.start + 0.012);
      envelope.gain.exponentialRampToValueAtTime(0.001, start + note.start + note.duration);
      oscillator.connect(envelope);
      envelope.connect(master);
      oscillator.start(start + note.start);
      oscillator.stop(start + note.start + note.duration + 0.05);
      lastEnd = Math.max(lastEnd, start + note.start + note.duration);
    }
    // Encerra o contexto para não acumular instâncias (limite do Safari).
    if (typeof window !== "undefined") {
      window.setTimeout(() => void closeAudioContext(context), Math.max(100, (lastEnd - context.currentTime + 0.1) * 1000));
    } else {
      void closeAudioContext(context);
    }
  } catch {
    // Som é cosmético: navegador sem Web Audio ou autoplay bloqueado segue o fluxo.
  }
}

function closeAudioContext(context: AudioContext): void {
  try {
    if (typeof context.close === "function") void context.close().catch(() => undefined);
  } catch {
    // Navegadores antigos sem close(): o GC resolve.
  }
}