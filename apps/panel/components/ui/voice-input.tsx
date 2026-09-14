"use client";

import { Pause, Play, Stop, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "../tripz-ai/tripz-ai.module.css";
import {
  AUDIO_WAVEFORM_BAR_COUNT,
  formatAudioDuration,
  sampleAudioWaveform
} from "@/lib/audio-waveform";

const EMPTY_WAVEFORM = Array.from({ length: AUDIO_WAVEFORM_BAR_COUNT }, (_, index) =>
  0.16 + ((index * 7) % 5) * 0.035
);

function WaveformBars({
  amplitudes,
  className = "",
  barClassName = ""
}: {
  amplitudes: readonly number[];
  className?: string;
  barClassName?: string;
}) {
  return (
    <div className={`${styles.voiceWave} ${className}`} aria-hidden="true">
      {amplitudes.map((amplitude, index) => (
        <span
          // The position is stable and the decoded sample has no natural identifier.
          key={index}
          className={`h-full min-w-0 flex-1 rounded-full bg-current will-change-transform ${barClassName}`}
          style={{ transform: `scaleY(${amplitude})` }}
        />
      ))}
    </div>
  );
}

export function LiveAudioWaveform({ stream }: { stream: MediaStream | null }) {
  const barsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!stream || typeof AudioContext === "undefined") return;
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    const source = context.createMediaStreamSource(stream);
    const history = Array.from({ length: 34 }, () => 0.08);
    let animationFrame = 0;

    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.72;
    const samples = new Uint8Array(analyser.fftSize);
    source.connect(analyser);
    let cancelled = false;

    const draw = () => {
      if (cancelled) return;
      analyser.getByteTimeDomainData(samples);
      let squaredTotal = 0;
      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        squaredTotal += normalized * normalized;
      }
      const rms = Math.sqrt(squaredTotal / samples.length);
      history.shift();
      history.push(Math.min(1, Math.max(0.08, rms * 4.8)));
      barsRef.current?.querySelectorAll<HTMLElement>("[data-wave-bar]").forEach((bar, index) => {
        bar.style.transform = `scaleY(${history[index] ?? 0.08})`;
      });
      animationFrame = requestAnimationFrame(draw);
    };

    void context.resume().then(draw, draw);
    return () => {
      cancelled = true;
      cancelAnimationFrame(animationFrame);
      source.disconnect();
      analyser.disconnect();
      void context.close();
    };
  }, [stream]);

  return (
    <div ref={barsRef} className="flex h-8 min-w-0 flex-1 items-center gap-[2px] overflow-hidden" aria-hidden="true">
      {Array.from({ length: 34 }, (_, index) => (
        <span
          key={index}
          data-wave-bar
          className="h-full min-w-[2px] flex-1 origin-center rounded-full bg-current opacity-80 will-change-transform"
          style={{ transform: "scaleY(.08)" }}
        />
      ))}
    </div>
  );
}

export function VoiceInput({
  stream,
  elapsedSeconds,
  onCancel,
  onStop
}: {
  stream: MediaStream | null;
  elapsedSeconds: number;
  onCancel: () => void;
  onStop: () => void;
}) {
  return (
    <div className="mb-3 flex min-w-0 items-center gap-2.5 rounded-[10px] border border-[var(--warning-border)] bg-[var(--warning-subtle)] px-2.5 py-2 text-[var(--warning)]">
      <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-current" aria-hidden="true" />
      <strong className="sr-only" role="status">Gravando áudio</strong>
      <LiveAudioWaveform stream={stream} />
      <span className="mono w-11 shrink-0 text-center text-[11px] tabular-nums" aria-hidden="true">
        {formatAudioDuration(elapsedSeconds)}
      </span>
      <button type="button" onClick={onCancel} className="btn h-9 w-9 shrink-0 p-0 active:scale-[.98]" aria-label="Cancelar gravação">
        <X size={16} />
      </button>
      <button type="button" onClick={onStop} className="btn h-9 w-9 shrink-0 p-0 active:scale-[.98]" aria-label="Concluir gravação">
        <Stop size={16} weight="fill" />
      </button>
    </div>
  );
}

export function VoiceMessagePlayer({ src, label = "mensagem de áudio" }: { src: string; label?: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const rangeRef = useRef<HTMLInputElement>(null);
  const currentTimeRef = useRef<HTMLSpanElement>(null);
  const animationFrameRef = useRef(0);
  const lastProgressBarRef = useRef(-1);
  const [amplitudes, setAmplitudes] = useState<number[]>(EMPTY_WAVEFORM);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loadingWaveform, setLoadingWaveform] = useState(true);
  const [playbackError, setPlaybackError] = useState("");

  const renderTimeline = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const resolvedDuration = Number.isFinite(audio.duration) ? audio.duration : duration;
    const progress = resolvedDuration > 0 ? Math.min(1, audio.currentTime / resolvedDuration) : 0;
    const playedBars = Math.round(progress * amplitudes.length);
    if (progressRef.current && playedBars !== lastProgressBarRef.current) {
      progressRef.current.querySelectorAll<HTMLElement>("span").forEach((bar, index) => {
        bar.style.opacity = index < playedBars ? "1" : "0";
      });
      lastProgressBarRef.current = playedBars;
    }
    if (rangeRef.current) rangeRef.current.value = String(audio.currentTime);
    if (currentTimeRef.current) currentTimeRef.current.textContent = formatAudioDuration(audio.currentTime);
  }, [amplitudes.length, duration]);

  const stopTimeline = useCallback(() => {
    cancelAnimationFrame(animationFrameRef.current);
  }, []);

  const runTimeline = useCallback(() => {
    stopTimeline();
    const tick = () => {
      renderTimeline();
      const audio = audioRef.current;
      if (audio && !audio.paused && !audio.ended) animationFrameRef.current = requestAnimationFrame(tick);
    };
    animationFrameRef.current = requestAnimationFrame(tick);
  }, [renderTimeline, stopTimeline]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setAmplitudes(EMPTY_WAVEFORM);
    setDuration(0);
    setPlaying(false);
    setLoadingWaveform(true);
    setPlaybackError("");
    lastProgressBarRef.current = -1;
    progressRef.current?.querySelectorAll<HTMLElement>("span").forEach((bar) => {
      bar.style.opacity = "0";
    });
    if (currentTimeRef.current) currentTimeRef.current.textContent = "00:00";
    if (rangeRef.current) rangeRef.current.value = "0";

    void (async () => {
      let context: AudioContext | null = null;
      try {
        if (typeof AudioContext === "undefined") throw new Error("Web Audio API indisponível");
        const response = await fetch(src, { credentials: "include", signal: controller.signal });
        if (!response.ok) throw new Error(`Falha ao carregar áudio (${response.status})`);
        const encodedAudio = await response.arrayBuffer();
        context = new AudioContext();
        const decodedAudio = await context.decodeAudioData(encodedAudio.slice(0));
        if (cancelled) return;
        const channels = Array.from({ length: decodedAudio.numberOfChannels }, (_, index) => decodedAudio.getChannelData(index));
        setAmplitudes(sampleAudioWaveform(channels));
        setDuration(decodedAudio.duration);
      } catch (error) {
        if (!cancelled && !(error instanceof DOMException && error.name === "AbortError")) {
          setAmplitudes(EMPTY_WAVEFORM);
        }
      } finally {
        if (!cancelled) setLoadingWaveform(false);
        if (context) void context.close();
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [src]);

  useEffect(() => () => {
    stopTimeline();
    audioRef.current?.pause();
  }, [stopTimeline]);

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) return;
    setPlaybackError("");
    if (!audio.paused) {
      audio.pause();
      return;
    }
    try {
      await audio.play();
    } catch {
      setPlaybackError("Não foi possível reproduzir este áudio");
    }
  }

  return (
    <div className="min-w-0 flex-1">
      <div className={styles.voicePlayer}>
        <audio
          ref={audioRef}
          src={src}
          preload="metadata"
          onLoadedMetadata={(event) => {
            if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration);
            renderTimeline();
          }}
          onPlay={() => {
            setPlaying(true);
            runTimeline();
          }}
          onPause={() => {
            setPlaying(false);
            stopTimeline();
            renderTimeline();
          }}
          onEnded={() => {
            setPlaying(false);
            stopTimeline();
            renderTimeline();
          }}
          onError={() => setPlaybackError("Não foi possível carregar este áudio")}
        />
        <button
          type="button"
          onClick={togglePlayback}
          className="btn primary h-9 w-9 shrink-0 rounded-full p-0 active:scale-[.98]"
          aria-label={`${playing ? "Pausar" : "Reproduzir"} ${label}`}
        >
          {playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className={styles.voiceTrack}>
            <WaveformBars amplitudes={amplitudes} className={`text-[var(--text-muted)] ${loadingWaveform ? "animate-pulse" : ""}`} />
            <div ref={progressRef} className="pointer-events-none absolute inset-0 overflow-hidden text-[var(--primary)]">
              <WaveformBars amplitudes={amplitudes} className="w-full" barClassName="opacity-0" />
            </div>
            <input
              ref={rangeRef}
              type="range"
              min="0"
              max={Math.max(duration, 0.01)}
              step="0.01"
              defaultValue="0"
              onChange={(event) => {
                if (!audioRef.current) return;
                audioRef.current.currentTime = Number(event.currentTarget.value);
                renderTimeline();
              }}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              aria-label={`Posição de reprodução de ${label}`}
            />
          </div>
          <div className="mono mt-1 flex justify-between text-[9px] tabular-nums text-[var(--text-muted)]" aria-hidden="true">
            <span ref={currentTimeRef}>00:00</span>
            <span>{duration > 0 ? formatAudioDuration(duration) : "--:--"}</span>
          </div>
        </div>
      </div>
      {playbackError ? <p className="mt-1 text-[10px] text-[var(--danger)]" role="alert">{playbackError}</p> : null}
    </div>
  );
}
