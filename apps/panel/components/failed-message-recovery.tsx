import { ArrowClockwise, Warning } from "@phosphor-icons/react";

export interface FailedMessageRecoveryState {
  available: number;
  ambiguous: number;
  has_connected_session: boolean;
  legacy_unrecoverable: number;
  oldest_at: string | null;
}

export function FailedMessageRecovery({
  recovery,
  canManage,
  connected = true,
  recovering,
  confirming,
  error,
  onConfirm,
  onCancel,
  onRecover
}: {
  recovery: FailedMessageRecoveryState;
  canManage: boolean;
  connected?: boolean;
  recovering: boolean;
  confirming: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
  onRecover: () => void;
}) {
  const availableLabel = recovery.available === 1 ? "1 mensagem de texto" : `${recovery.available} mensagens de texto`;
  const ambiguousLabel = recovery.ambiguous === 1 ? "1 envio foi aceito" : `${recovery.ambiguous} envios foram aceitos`;
  const disabled = !canManage || !connected || recovering || recovery.available === 0;

  return (
    <section className="card mb-6" aria-labelledby="failed-message-recovery-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <Warning className="mt-0.5 shrink-0 text-[var(--warning-text)]" size={20} aria-hidden="true" />
          <div>
            <h2 id="failed-message-recovery-title" className="text-sm font-semibold">Mensagens não entregues</h2>
            {recovery.available > 0 ? (
              <p className="mt-1 text-sm text-[var(--text-secondary)]">
                {availableLabel} podem ser reenviadas após a conexão voltar.
              </p>
            ) : (
              <p className="mt-1 text-sm text-[var(--text-secondary)]">Nenhuma mensagem recuperável está aguardando reenvio.</p>
            )}
            {recovery.legacy_unrecoverable > 0 ? (
              <p className="mt-2 text-xs leading-relaxed text-[var(--warning-text)]">
                {recovery.legacy_unrecoverable} falhas antigas não armazenaram o conteúdo e precisam ser revisadas nas conversas.
              </p>
            ) : null}
            {recovery.ambiguous > 0 ? (
              <p className="mt-2 text-xs leading-relaxed text-[var(--warning-text)]">
                {ambiguousLabel} pelo WhatsApp, mas precisa de revisão no histórico. Não será reenviado automaticamente.
              </p>
            ) : null}
            {!connected ? <p className="mt-2 text-xs text-[var(--warning-text)]">Reconecte o WhatsApp antes de reenviar.</p> : null}
            {error ? <p className="error mt-2" role="alert">{error}</p> : null}
          </div>
        </div>
        {!confirming ? (
          <button type="button" className="btn warn" disabled={disabled} onClick={onConfirm}>
            <ArrowClockwise size={16} className={recovering ? "animate-spin" : ""} aria-hidden="true" />
            {recovering ? "Reenviando…" : "Reenviar mensagens"}
          </button>
        ) : null}
      </div>

      {confirming ? (
        <div className="mt-4 border-t border-[var(--warning-border)] pt-4" role="alertdialog" aria-label="Confirmar reenvio de mensagens">
          <p className="text-sm leading-relaxed text-[var(--warning-text)]">
            Confirme o reenvio de {availableLabel}. Cada conteúdo será enviado uma única vez e registrado novamente na conversa.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn" disabled={recovering} onClick={onCancel}>Cancelar</button>
            <button type="button" className="btn warn" disabled={recovering || !connected} onClick={onRecover}>
              <ArrowClockwise size={16} className={recovering ? "animate-spin" : ""} aria-hidden="true" />
              {recovering ? "Reenviando…" : "Confirmar reenvio"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
