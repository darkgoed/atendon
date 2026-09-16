"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { usePermission } from "@/lib/use-permission";
import { Button, PageHeader } from "@/components/ui";
import styles from "@/components/settings-panels.module.css";

type Json = { [key: string]: number | string[] | Json };

const labels: Record<string, string> = {
  readDelay: "Atraso para leitura",
  readingPause: "Pausa de leitura",
  composing: "Digitação",
  presence: "Presença",
  debounce: "Agrupamento de mensagens",
  messageSplit: "Divisão em balões",
  timeOfDayMultiplier: "Fora do horário ativo",
  reaction: "Reações",
  rateLimit: "Limite de mensagens",
  min: "Mínimo",
  max: "Máximo",
  wpm: "Palavras por minuto",
  jitterMs: "Variação (s)",
  minMs: "Duração mínima (s)",
  maxMs: "Duração máxima (s)",
  resendIntervalMs: "Renovar digitando (s)",
  onlineSessionMin: "Sessão online (min)",
  offlineGapMin: "Intervalo offline (min)",
  inactivityBeforeUnavailableMin: "Inatividade até offline (min)",
  activeHours: "Horário ativo",
  start: "Início",
  end: "Fim",
  initialWindowMs: "Janela inicial (s)",
  silenceWindowMs: "Janela de silêncio (s)",
  extensionMs: "Extensão máxima (s)",
  maxWordsPerBubble: "Palavras por balão",
  pauseBetweenBubblesMs: "Pausa entre balões (s)",
  outsideActiveHours: "Multiplicador",
  probability: "Probabilidade",
  emojis: "Emojis",
  maxMessagesPerContactPerMinute: "Máximo por contato/minuto"
};

const millisecondMetrics = new Set([
  "readDelay",
  "readingPause",
  "jitterMs",
  "minMs",
  "maxMs",
  "resendIntervalMs",
  "initialWindowMs",
  "silenceWindowMs",
  "extensionMs",
  "pauseBetweenBubblesMs"
]);

function isMillisecondMetric(path: string[]) {
  return path.some((segment) => millisecondMetrics.has(segment));
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function HumanizacaoPage() {
  const canManage = usePermission("humanizer.manage");
  const [value, setValue] = useState<Json>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadHumanizer = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const response = await api<{ humanizer: Json }>("/humanizer", { signal });
      setValue(response.humanizer);
    } catch (loadError) {
      if (!signal?.aborted) {
        setValue(undefined);
        setError(errorMessage(loadError, "Não foi possível carregar a configuração."));
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadHumanizer(controller.signal);
    return () => controller.abort();
  }, [loadHumanizer]);

  function update(path: string[], next: number | string[]) {
    setSaved(false);
    setValue((current) => {
      if (!current) return current;
      const copy = structuredClone(current);
      let node: Json = copy;
      for (const key of path.slice(0, -1)) node = node[key] as Json;
      node[path.at(-1)!] = next;
      return copy;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || !value || saving) return;

    setError("");
    setSaved(false);
    setSaving(true);
    try {
      await api("/humanizer", { method: "PUT", body: JSON.stringify(value) });
      setSaved(true);
    } catch (saveError) {
      setError(errorMessage(saveError, "Falha ao salvar a configuração."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell>
      <PageHeader title="Humanização" description="Timing, presença, agrupamento, reações e limites configurados por tenant." />

      {error ? (
        <section className="mb-4 flex flex-wrap items-center justify-between gap-3 border-y border-[var(--warning-border)] bg-[var(--warning-subtle)] px-4 py-4" role="alert">
          <p className="error">{error}</p>
          {!value ? <button type="button" className="btn warn" onClick={() => void loadHumanizer()}>Tentar novamente</button> : null}
        </section>
      ) : null}

      {loading ? (
        <div role="status" aria-busy="true">
          <span className="sr-only">Carregando configuração de humanização</span>
          <div className="skeleton h-96" aria-hidden="true" />
        </div>
      ) : value ? (
        <form aria-busy={saving} onSubmit={submit}>
          <fieldset className="contents" disabled={!canManage || saving}>
            <div className="grid gap-4 xl:grid-cols-2">
              {Object.entries(value).map(([key, item]) => (
                <Group key={key} name={key} value={item as Json} path={[key]} update={update} />
              ))}
            </div>
          </fieldset>
          <div className={styles.saveBar}>
            {!canManage ? <span className="text-sm text-[var(--text-secondary)]">Acesso somente leitura.</span> : null}
            {saved ? <span className="text-sm text-[var(--primary-text)]" role="status">Configuração salva.</span> : null}
            <Button type="submit" tone="primary" disabled={saving || !canManage}>
              {saving ? "Salvando…" : "Salvar humanização"}
            </Button>
          </div>
        </form>
      ) : null}
    </Shell>
  );
}

function Group({ name, value, path, update }: {
  name: string;
  value: Json;
  path: string[];
  update: (path: string[], value: number | string[]) => void;
}) {
  return (
    <section className="line-section">
      <div className="cardtitle">{labels[name] ?? name}</div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {Object.entries(value).map(([key, item]) => typeof item === "object" && !Array.isArray(item) ? (
          <div className="border-t border-[var(--border)] pt-4 sm:col-span-2" key={key}>
            <strong className="mb-3 block text-sm">{labels[key] ?? key}</strong>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {Object.entries(item).map(([nested, nestedValue]) => (
                <Leaf
                  key={nested}
                  name={nested}
                  value={nestedValue as number | string[]}
                  path={[...path, key, nested]}
                  update={update}
                />
              ))}
            </div>
          </div>
        ) : (
          <Leaf key={key} name={key} value={item as number | string[]} path={[...path, key]} update={update} />
        ))}
      </div>
    </section>
  );
}

function Leaf({ name, value, path, update }: {
  name: string;
  value: number | string[];
  path: string[];
  update: (path: string[], value: number | string[]) => void;
}) {
  const milliseconds = !Array.isArray(value) && isMillisecondMetric(path);
  const label = milliseconds && (name === "min" || name === "max")
    ? `${labels[name]} (s)`
    : (labels[name] ?? name);

  return (
    <label className={`field ${Array.isArray(value) ? "sm:col-span-2" : ""}`}>
      <span className="label">{label}</span>
      {Array.isArray(value) ? (
        <input
          className="input"
          value={value.join(" ")}
          onChange={(event) => update(path, event.target.value.split(/\s+/).filter(Boolean))}
        />
      ) : (
        <input
          className="input"
          type="number"
          step={milliseconds ? "0.001" : name === "probability" || name === "outsideActiveHours" ? "0.01" : "1"}
          value={milliseconds ? value / 1_000 : value}
          onChange={(event) => update(path, milliseconds ? Math.round(Number(event.target.value) * 1_000) : Number(event.target.value))}
        />
      )}
    </label>
  );
}
