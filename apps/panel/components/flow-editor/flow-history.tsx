"use client";

/* Histórico de versões do fluxo (SPEC flow-integrity R3/WP-C): lista os
   snapshots (GET /qualification/flows/:id/versions — a listagem NÃO traz
   definition e o componente não depende dela), confirma a restauração
   comparando contagens de etapas/arestas (GET /versions/diff entre a versão
   alvo e a mais recente — opcional: sem diff quando a alvo É a mais recente
   ou o diff falha) e restaura (POST /versions/:versionId/restore, versionId =
   UUID da linha) enviando revisao_base (CAS). 409 FLOW_VERSION_CONFLICT é
   tratado como no save: sobe para a página via onConflict, que abre o
   FlowConflictModal e recarrega via SWR mutate. */

import { useCallback, useState } from "react";
import useSWR from "swr";
import { ModalDialog } from "@/components/modal-dialog";
import { SaveButton } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import type { FlowConflict } from "./FlowConflictModal";
import styles from "./flow-history.module.css";

type FlowVersionRow = {
  id: string; // UUID de flow_versions.id — é o versionId do restore
  version: number;
  flow_name: string;
  created_by: string | null;
  created_at: string;
};

type VersionsResponse = { versions: FlowVersionRow[]; next_cursor: string | null };

/* Shape de GET /versions/diff (routes.ts:304-338): added/removed são as etapas
   do lado "to" que não estão no lado "from" (e vice-versa); modified compara
   o JSON da etapa; edges idem por conexão rotulada. */
type VersionDiff = {
  added: string[];
  removed: string[];
  modified: string[];
  edges: { added: unknown[]; removed: unknown[] };
};

type DiffResponse = { from: { version: number }; to: { version: number }; diff: VersionDiff };

type RestoreResponse = { flow: { revisao: number }; restored_from: number; version: number };

const versionsFetcher = (url: string) => api<VersionsResponse>(url);

/** 409 do restore tem o MESMO shape do save (routes.ts:378): { code, revisao }. */
function flowConflictRevisao(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as { code?: unknown; revisao?: unknown };
  if (record.code !== "FLOW_VERSION_CONFLICT" || typeof record.revisao !== "number") return null;
  return record.revisao;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("pt-BR");
}

export function FlowHistory({
  flowId,
  revisao,
  canManage,
  onRestored,
  onConflict,
  onClose,
}: {
  flowId: string;
  /** Revisão viva conhecida pela página — vai como revisao_base no restore. */
  revisao: number | null;
  canManage: boolean;
  onRestored: () => void;
  onConflict: (conflict: FlowConflict) => void;
  onClose: () => void;
}) {
  const { data, error, isLoading } = useSWR(`/qualification/flows/${flowId}/versions`, versionsFetcher);
  const versions = data?.versions ?? [];
  const newest = versions[0]; // keyset version DESC — a primeira linha é a mais recente

  const [target, setTarget] = useState<FlowVersionRow | null>(null);
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  /* Confirmação com contagens: diff entre a versão MAIS RECENTE e a alvo.
     Direção (from=nova, to=alvo): added = etapas que VOLTAM com o restore,
     removed = etapas que SAEM, edges idem por conexão. Diff é opcional —
     se falhar, a confirmação segue sem contagens (nunca bloqueia). */
  const askRestore = useCallback(
    async (row: FlowVersionRow) => {
      setRestoreError(null);
      setDiff(null);
      setTarget(row);
      if (!newest || newest.version === row.version) return; // alvo já é a mais recente
      try {
        const payload = await api<DiffResponse>(
          `/qualification/flows/${flowId}/versions/diff?from=${newest.version}&to=${row.version}`,
        );
        setDiff(payload.diff);
      } catch {
        setDiff(null);
      }
    },
    [flowId, newest],
  );

  const restore = useCallback(async () => {
    const row = target;
    if (!row) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      await api<RestoreResponse>(`/qualification/flows/${flowId}/versions/${row.id}/restore`, {
        method: "POST",
        body: JSON.stringify({ revisao_base: revisao ?? 0 }),
      });
      onRestored();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        const servidor = flowConflictRevisao(cause.body);
        if (servidor !== null) {
          onConflict({ revisao: servidor }); // a página abre o mesmo modal do save
          return;
        }
      }
      setRestoreError(cause instanceof ApiError ? cause.message : "Falha ao restaurar a versão");
    } finally {
      setRestoring(false);
    }
  }, [flowId, onConflict, onRestored, revisao, target]);

  if (target) {
    return (
      <ModalDialog labelledBy="flow-restore-title" describedBy="flow-restore-text" onClose={onClose} dialogClassName={`action-dialog ${styles.historyDialog}`}>
        <h2 id="flow-restore-title">Restaurar versão {target.version}?</h2>
        <p id="flow-restore-text">
          A definição atual do fluxo será substituída pela versão {target.version} (salva em {formatDate(target.created_at)}).
          Um snapshot novo é criado no histórico; a versão restaurada permanece.
        </p>
        {diff ? (
          <div className={styles.diffBox} role="status" data-testid="flow-history-diff">
            Comparação com a versão {newest?.version} (mais recente):
            <ul>
              <li>
                Etapas: {diff.added.length} voltam, {diff.removed.length} saem, {diff.modified.length} modificada(s)
              </li>
              <li>
                Conexões: {diff.edges.added.length} criada(s), {diff.edges.removed.length} removida(s)
              </li>
            </ul>
          </div>
        ) : null}
        {restoreError ? <p className="error" role="alert">{restoreError}</p> : null}
        <div className={styles.actions}>
          <button type="button" className="btn" onClick={() => setTarget(null)} disabled={restoring}>
            Cancelar
          </button>
          {/* Padrão de salvar DS v2 (§2) — flag `restoring` própria: idle → busy
              ("Restaurando…"); o done é o fechamento do diálogo pelo onRestored. */}
          <SaveButton
            state={restoring ? "busy" : "idle"}
            busyLabel="Restaurando…"
            data-testid="flow-history-confirm"
            onClick={() => void restore()}
            disabled={restoring || !canManage}
          >
            Restaurar versão
          </SaveButton>
        </div>
      </ModalDialog>
    );
  }

  return (
    <ModalDialog labelledBy="flow-history-title" onClose={onClose} dialogClassName={`action-dialog ${styles.historyDialog}`}>
      <h2 id="flow-history-title">Histórico de versões</h2>
      {isLoading ? <p className="sub">Carregando…</p> : null}
      {error ? <p className="error" role="alert">Não foi possível carregar o histórico.</p> : null}
      {!isLoading && !error && versions.length === 0 ? (
        <p className="sub">Nenhuma versão ainda. O histórico recebe um snapshot a cada salvamento da definição.</p>
      ) : null}
      <ul className={styles.list}>
        {versions.map((row) => (
          <li key={row.id} className={styles.row}>
            <div style={{ minWidth: 0 }}>
              <strong>{row.flow_name || `Versão ${row.version}`}</strong>
              <span className={styles.meta}>
                Versão {row.version} · {formatDate(row.created_at)}
                {row.created_by ? ` · ${row.created_by.slice(0, 8)}` : ""}
              </span>
            </div>
            <button
              type="button"
              className="btn"
              data-testid={`flow-history-restore-${row.version}`}
              onClick={() => void askRestore(row)}
              disabled={!canManage || restoring}
            >
              Restaurar
            </button>
          </li>
        ))}
      </ul>
    </ModalDialog>
  );
}
