"use client";

/* Modal do 409 FLOW_VERSION_CONFLICT (SPEC flow-integrity R2/R4): o servidor
   está numa revisão mais nova que a cópia do editor — salvar a partir da cópia
   velha pode sobrescrever o salvamento alheio. Oferece Recarregar (onReload —
   SWR mutate na página) e atalho para o Histórico (R3) via onOpenHistory — a
   Histórico é o drawer da página (flow-history), não rota: sem callback, sem
   botão. O wiring do save (revisao_base + captura do 409 no catch) entra no
   M3 da WP-A. */

import { ModalDialog } from "@/components/modal-dialog";
import styles from "./flow-editor.module.css";

export type FlowConflict = { revisao: number; atualizado_em?: string | null };

export function FlowConflictModal({
  conflict,
  onReload,
  onOpenHistory,
  onClose,
}: {
  conflict: FlowConflict;
  onReload: () => void;
  onOpenHistory?: () => void;
  onClose: () => void;
}) {
  let atualizadoEm = "";
  if (conflict.atualizado_em) {
    const parsed = new Date(conflict.atualizado_em);
    atualizadoEm = Number.isNaN(parsed.getTime())
      ? conflict.atualizado_em
      : parsed.toLocaleString("pt-BR");
  }
  return (
    <ModalDialog
      labelledBy="flow-conflict-title"
      describedBy="flow-conflict-text"
      onClose={onClose}
      dialogClassName={`action-dialog ${styles.conflictDialog}`}
    >
      <h2 id="flow-conflict-title" className={styles.conflictTitle}>Fluxo alterado por outro salvamento</h2>
      <p id="flow-conflict-text" className={styles.conflictText}>
        O servidor está na revisão <strong>{conflict.revisao}</strong>
        {atualizadoEm ? <> (atualizado em {atualizadoEm})</> : null}. Salvar a partir da sua cópia pode sobrescrever essas mudanças.
      </p>
      <div className={styles.conflictActions}>
        <button type="button" className="btn primary" data-testid="flow-conflict-reload" onClick={onReload}>
          Recarregar
        </button>
        {onOpenHistory ? (
          <button type="button" className="btn" data-testid="flow-conflict-history" onClick={onOpenHistory}>
            Ver histórico
          </button>
        ) : null}
        <button type="button" className="btn" onClick={onClose}>
          Continuar editando
        </button>
      </div>
    </ModalDialog>
  );
}
