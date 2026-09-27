"use client";

import { useCallback, useEffect, useState } from "react";
import { X, WarningCircle } from "@/components/icons";
import { getTripzBrandSettings, updateTripzBrandSettings, type TripzProposalBrandConfig } from "@/lib/tripz-ai";

type Props = {
  onSaved?: (config: TripzProposalBrandConfig) => void;
  onClose?: () => void;
};

const TOKEN_FIELDS: Array<[string, string]> = [
  ["primary", "Azul profundo"],
  ["secondary", "Azul médio"],
  ["accent", "Terracota"],
  ["background", "Fundo"],
  ["sand", "Areia"]
];

export function TripzBrandSettings({ onSaved, onClose }: Props) {
  const [config, setConfig] = useState<TripzProposalBrandConfig>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setConfig(await getTripzBrandSettings());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao carregar o brand");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const tokens = (config.tokens ?? {}) as Record<string, string>;

  function setToken(key: string, value: string) {
    setConfig((current) => ({ ...current, tokens: { ...((current.tokens ?? {}) as Record<string, string>), [key]: value } }));
  }

  function setField(key: "styleNotes" | "name", value: string) {
    setConfig((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const saved = await updateTripzBrandSettings(config);
      setSavedAt(new Date().toLocaleTimeString("pt-BR"));
      onSaved?.(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao salvar o brand");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-3 text-xs">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Identidade da proposta</h2>
        {onClose ? <button type="button" className="btn-icon" onClick={onClose} aria-label="Fechar"><X size={14} aria-hidden="true" /></button> : null}
      </header>
      {loading ? <p className="text-[var(--text-secondary)]">Carregando…</p> : null}
      <label className="grid gap-1">Nome exibido
        <input className="input" value={String(config.name ?? "")} onChange={(event) => setField("name", event.target.value)} />
      </label>
      <fieldset className="grid grid-cols-2 gap-2">
        <legend className="mb-1 font-semibold">Cores</legend>
        {TOKEN_FIELDS.map(([key, label]) => (
          <label key={key} className="grid gap-1">{label}
            <input type="color" className="h-8 w-full" value={tokens[key] ?? "#000000"} onChange={(event) => setToken(key, event.target.value)} />
          </label>
        ))}
      </fieldset>
      <label className="grid gap-1">Estilo textual (instrução permanente para a IA)
        <textarea className="input min-h-24" value={String(config.styleNotes ?? "")} onChange={(event) => setField("styleNotes", event.target.value)} />
      </label>
      <div className="flex items-center justify-between gap-2">
        <button type="button" className="btn" disabled={saving} onClick={() => void save()}>{saving ? "Salvando…" : "Salvar identidade"}</button>
        {savedAt ? <span className="text-[11px] text-[var(--text-secondary)]">Salvo às {savedAt}</span> : null}
      </div>
      {error ? (
        <p className="flex items-center gap-1 text-[var(--warning-text)]" role="alert">
          <WarningCircle size={12} weight="duotone" aria-hidden="true" /> {error}
        </p>
      ) : null}
    </div>
  );
}
