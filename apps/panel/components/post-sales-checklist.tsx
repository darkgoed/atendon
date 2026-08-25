"use client";

import { Archive, CheckCircle, FloppyDisk, ListChecks } from "@phosphor-icons/react";
import React, { useEffect, useState, type FormEvent } from "react";
import {
  checklistResultOptions,
  type PostSaleChecklistEntry,
  type PostSaleChecklistResult
} from "../lib/post-sales";

export function PostSalesChecklist({
  entries,
  savingId,
  errors = {},
  onSave
}: {
  entries: PostSaleChecklistEntry[];
  savingId?: string | null;
  errors?: Record<string, string>;
  onSave: (entry: PostSaleChecklistEntry, result: PostSaleChecklistResult, note: string | null) => Promise<void> | void;
}) {
  const active = entries.filter((entry) => !entry.item_archived_at && entry.is_active);
  const archived = entries.filter((entry) => Boolean(entry.item_archived_at) || !entry.is_active);

  if (active.length === 0 && archived.length === 0) {
    return (
      <div className="post-sales-checklist-empty" role="status">
        <ListChecks size={30} aria-hidden="true" />
        <strong>Checklist ainda vazio</strong>
        <p>Um gestor pode cadastrar os itens reais em Configurar checklist.</p>
      </div>
    );
  }

  return (
    <div className="post-sales-checklist" aria-label="Checklist de pós-venda">
      <div className="post-sales-checklist__list">
        {active.map((entry, index) => (
          <ChecklistEntryEditor
            key={entry.id}
            entry={entry}
            index={index}
            saving={savingId === entry.id}
            error={errors[entry.id]}
            onSave={onSave}
          />
        ))}
      </div>
      {archived.length ? (
        <details className="post-sales-checklist__history">
          <summary><Archive size={15} aria-hidden="true" /> Histórico arquivado ({archived.length})</summary>
          <div>
            {archived.map((entry) => (
              <article key={entry.id}>
                <span>{entry.description}</span>
                <strong>{checklistResultOptions.find((option) => option.value === entry.result)?.label}</strong>
                {entry.note ? <p>{entry.note}</p> : null}
              </article>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function ChecklistEntryEditor({
  entry,
  index,
  saving,
  error,
  onSave
}: {
  entry: PostSaleChecklistEntry;
  index: number;
  saving: boolean;
  error?: string;
  onSave: (entry: PostSaleChecklistEntry, result: PostSaleChecklistResult, note: string | null) => Promise<void> | void;
}) {
  const [result, setResult] = useState<PostSaleChecklistResult>(entry.result);
  const [note, setNote] = useState(entry.note ?? "");
  const dirty = result !== entry.result || note.trim() !== (entry.note ?? "");

  // ponytail: sem key por versão, o poll não remonta mais o form; só ressincroniza
  // quando o usuário não tem edição local pendente (evita apagar texto não salvo).
  useEffect(() => {
    if (dirty) return;
    setResult(entry.result);
    setNote(entry.note ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.version]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSave(entry, result, note.trim() || null);
  }

  return (
    <form
      className={`post-sales-checklist__entry post-sales-checklist__entry--${result}`}
      style={{ "--item-index": index } as React.CSSProperties}
      aria-busy={saving}
      onSubmit={submit}
    >
      <div className="post-sales-checklist__index" aria-hidden="true">
        {result === "aceito" ? <CheckCircle size={18} weight="fill" /> : String(index + 1).padStart(2, "0")}
      </div>
      <div className="post-sales-checklist__copy">
        <strong>{entry.description}</strong>
        <span>{entry.updated_by_name ? `Atualizado por ${entry.updated_by_name}` : "Aguardando registro"}</span>
      </div>
      <label className="field post-sales-checklist__result">
        <span className="sr-only">Resultado de {entry.description}</span>
        <select className="input" value={result} onChange={(event) => setResult(event.target.value as PostSaleChecklistResult)} disabled={saving}>
          {checklistResultOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <label className="field post-sales-checklist__note">
        <span className="sr-only">Nota de {entry.description}</span>
        <textarea className="input" rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Nota opcional" disabled={saving} />
      </label>
      <button className="btn post-sales-checklist__save" type="submit" disabled={saving || !dirty}>
        <FloppyDisk size={15} aria-hidden="true" />
        {saving ? "Salvando…" : "Salvar"}
      </button>
      {error ? <p className="post-sales-checklist__error error" role="alert">{error}</p> : null}
    </form>
  );
}
