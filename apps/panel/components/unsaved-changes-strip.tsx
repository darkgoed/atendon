"use client";

// R18 — Strip fina "Alterações não salvas", fixa no fim da viewport, discreta,
// sem modais. Ações chegam por slots de props (Ver alterações expande um
// popover com diff resumido; Descartar e Salvar são callbacks do dono do form).

import { useId, useState } from "react";
import { SaveButton } from "@/components/ui";
import styles from "./unsaved-changes-strip.module.css";

export type UnsavedChangeField = {
  label: string;
  before?: string | null;
  after?: string | null;
};

export function UnsavedChangesStrip({
  active,
  changes = [],
  message = "Alterações não salvas",
  onDiscard,
  onSave,
  saveLabel = "Salvar",
  saving = false
}: {
  active: boolean;
  /** Diff resumido exibido no "Ver alterações"; vazio esconde o botão. */
  changes?: UnsavedChangeField[];
  message?: string;
  onDiscard: () => void;
  onSave: () => void;
  saveLabel?: string;
  saving?: boolean;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const diffId = useId();
  if (!active) return null;
  return (
    <div className={styles.strip} role="region" aria-label="Alterações não salvas">
      {showDiff ? (
        <div id={diffId} className={styles.diff} role="group" aria-label="Resumo das alterações">
          <ul className={styles.diffList}>
            {changes.map((change) => (
              <li key={change.label} className={styles.diffRow}>
                <span className={styles.diffLabel}>{change.label}</span>
                <span className={styles.diffValues}>
                  <span className={styles.before}>{change.before?.trim() ? change.before : "vazio"}</span>
                  <span aria-hidden="true" className={styles.arrow}>→</span>
                  <span className={styles.after}>{change.after?.trim() ? change.after : "vazio"}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className={styles.bar}>
        <span className={styles.message}>{message}</span>
        <span className={styles.actions}>
          {changes.length ? (
            <button
              type="button"
              className={styles.link}
              aria-expanded={showDiff}
              aria-controls={diffId}
              onClick={() => setShowDiff((current) => !current)}
            >
              {showDiff ? "Ocultar alterações" : "Ver alterações"}
            </button>
          ) : null}
          <button type="button" className={styles.link} onClick={onDiscard} disabled={saving}>
            Descartar
          </button>
          <SaveButton size="sm" tone="primary" state={saving ? "busy" : "idle"} busyLabel="Salvando…" onClick={onSave} disabled={saving}>
            {saveLabel}
          </SaveButton>
        </span>
      </div>
    </div>
  );
}
