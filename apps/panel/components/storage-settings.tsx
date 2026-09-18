"use client";

import { FloppyDisk, HardDrives } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useState } from "react";
import useSWR from "swr";
import { api } from "@/lib/api";
import { Progress } from "@/components/ui/status";
import styles from "@/components/storage-settings.module.css";

export type StorageOrigem = { origem: string; bytes: number; itens: number };
export type OrganizationStorage = {
  used_bytes: number;
  quota_bytes: number | null;
  retention_days: number | null;
  per_origem: StorageOrigem[];
};
export type StorageSettingsProps = { canManage: boolean; onSaved?: () => void };

const ORIGEM_LABELS: Record<string, string> = {
  figurinhas_ia: "Figurinhas da IA",
  midias_follow_up: "Mídias de follow-up",
  midias_instagram: "Mídias do Instagram",
  anexos_tripz: "Anexos Tripz",
  logo_workspace: "Logo do workspace"
};

function origemLabel(origem: string): string {
  return ORIGEM_LABELS[origem] ?? origem;
}

/** B/KB/MB/GB/TB em pt-BR; 1 decimal abaixo de 10 da unidade. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  const digits = value < 10 ? 1 : 0;
  return `${value.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[unit]}`;
}

// O PATCH devolve somente os campos de configuração (SEM per_origem).
type StorageSettingsPatchResponse = { storage: Pick<OrganizationStorage, "used_bytes" | "quota_bytes" | "retention_days"> };

export function StorageSettingsPanel({ canManage, onSaved }: StorageSettingsProps) {
  const { data, error, isLoading, mutate } = useSWR<{ storage: OrganizationStorage }>(
    "/organization/storage",
    (url: string) => api<{ storage: OrganizationStorage }>(url),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const [quotaGb, setQuotaGb] = useState("");
  const [retentionDays, setRetentionDays] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!data) return;
    setQuotaGb(data.storage.quota_bytes === null ? "" : String(data.storage.quota_bytes / 1024 ** 3));
    setRetentionDays(data.storage.retention_days === null ? "" : String(data.storage.retention_days));
  }, [data]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaveError("");
    setSaved(false);
    try {
      const response = await api<StorageSettingsPatchResponse>("/organization/storage/settings", {
        method: "PATCH",
        body: JSON.stringify({
          storage_quota_bytes: quotaGb.trim() === "" ? null : Math.round(Number(quotaGb) * 1024 ** 3),
          retention_days: retentionDays.trim() === "" ? null : Number(retentionDays)
        })
      });
      // A resposta não traz per_origem: mescla com spread para não apagá-la.
      await mutate((current) => current ? { storage: { ...current.storage, ...response.storage } } : current, { revalidate: false });
      setSaved(true);
      onSaved?.();
    } catch (submitError) {
      setSaveError(submitError instanceof Error ? submitError.message : "Não foi possível salvar o armazenamento.");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div className="grid max-w-2xl gap-4" aria-busy="true" aria-label="Carregando armazenamento">
        <div className="skeleton h-8 w-2/5" />
        <div className="skeleton h-28" />
      </div>
    );
  }

  const storage = data?.storage;
  return (
    <form className="max-w-2xl border-t border-[var(--border)] pt-6" onSubmit={submit}>
      <div className="grid gap-5 sm:grid-cols-[40px_minmax(0,1fr)]">
        <span className="grid h-10 w-10 place-items-center rounded-full border border-[var(--border)] text-[var(--primary-text)]">
          <HardDrives size={19} aria-hidden="true" />
        </span>
        <div className="grid gap-5">
          <div>
            <h2 className="m-0 text-base font-semibold text-[var(--text)]">Armazenamento</h2>
            <p className="sub mt-1">
              Uso por origem, quota total da empresa e retenção automática de mídias. Quota vazia = ilimitada; retenção vazia = sem exclusão automática.
            </p>
          </div>
          {error || saveError ? (
            <p className="error" role="alert">{saveError || (error instanceof Error ? error.message : "Não foi possível carregar o armazenamento.")}</p>
          ) : null}
          {saved ? <p className="text-sm text-[var(--primary-text)]" role="status">Armazenamento salvo.</p> : null}
          {storage ? (
            <section aria-label="Uso por origem">
              <p className="text-sm">
                Uso atual: <strong>{formatBytes(storage.used_bytes)}</strong>
                {storage.quota_bytes === null ? " de quota ilimitada" : ` de ${formatBytes(storage.quota_bytes)}`}
                {storage.retention_days !== null ? ` · retenção de ${storage.retention_days} ${storage.retention_days === 1 ? "dia" : "dias"}` : ""}
              </p>
              <ul className={styles.origins}>
                {storage.per_origem.map((item) => (
                  <li key={item.origem}>
                    <div className={styles.originMeta}>
                      <span>{origemLabel(item.origem)}</span>
                      <span className="mono text-xs">
                        {formatBytes(item.bytes)} · {item.itens} {item.itens === 1 ? "item" : "itens"}
                        {storage.quota_bytes === null ? " · ilimitado" : ""}
                      </span>
                    </div>
                    {storage.quota_bytes !== null ? (
                      <Progress
                        value={(item.bytes / storage.quota_bytes) * 100}
                        label={`Uso de ${origemLabel(item.origem)}`}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="field">
              <span className="label">Quota (GB)</span>
              <input
                className="input mono"
                type="number"
                min="0"
                step="any"
                value={quotaGb}
                placeholder="Ilimitado"
                disabled={!canManage}
                onChange={(event) => { setQuotaGb(event.target.value); setSaved(false); }}
              />
              <small className="sub">Vazio = ilimitado.</small>
            </label>
            <label className="field">
              <span className="label">Retenção (dias)</span>
              <input
                className="input mono"
                type="number"
                min="1"
                step="1"
                value={retentionDays}
                placeholder="Sem retenção"
                disabled={!canManage}
                onChange={(event) => { setRetentionDays(event.target.value); setSaved(false); }}
              />
              <small className="sub">Exclui mídias criadas há mais de N dias. Vazio = desligado.</small>
            </label>
          </div>
          {canManage ? (
            <div>
              <button type="submit" className="btn primary active:scale-[0.98]" disabled={saving}>
                <FloppyDisk size={16} aria-hidden="true" />
                {saving ? "Salvando…" : "Salvar"}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </form>
  );
}
