export const AUDIO_WAVEFORM_BAR_COUNT = 48;

const MIN_BAR_SCALE = 0.08;

export function formatAudioDuration(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(safeSeconds % 60).padStart(2, "0")}`;
}

export function audioDisplayName(fileName?: string | null, fallback = "Mensagem de áudio"): string {
  const trimmed = fileName?.trim();
  if (!trimmed) return fallback;
  const withoutExtension = trimmed.replace(/\.[a-z0-9]{1,10}$/iu, "");
  return withoutExtension || fallback;
}

export function sampleAudioWaveform(
  channels: readonly Float32Array[],
  barCount = AUDIO_WAVEFORM_BAR_COUNT
): number[] {
  const safeBarCount = Math.max(1, Math.floor(barCount));
  const sampleLength = channels.reduce((longest, channel) => Math.max(longest, channel.length), 0);
  if (!channels.length || !sampleLength) return Array.from({ length: safeBarCount }, () => MIN_BAR_SCALE);

  const amplitudes = Array.from({ length: safeBarCount }, (_, barIndex) => {
    const start = Math.floor((barIndex * sampleLength) / safeBarCount);
    const end = Math.max(start + 1, Math.floor(((barIndex + 1) * sampleLength) / safeBarCount));
    const stride = Math.max(1, Math.floor((end - start) / 512));
    let squaredTotal = 0;
    let samples = 0;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += stride) {
      for (const channel of channels) {
        if (sampleIndex >= channel.length) continue;
        const value = channel[sampleIndex] ?? 0;
        squaredTotal += value * value;
        samples += 1;
      }
    }

    return samples ? Math.sqrt(squaredTotal / samples) : 0;
  });

  const peak = Math.max(...amplitudes, 0.001);
  return amplitudes.map((amplitude) => Math.min(1, Math.max(MIN_BAR_SCALE, Math.pow(amplitude / peak, 0.72))));
}
