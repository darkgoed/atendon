"use client";

import { ArrowsClockwise, CheckCircle, PencilSimple, Plus, Star, Trash, Warning } from "@phosphor-icons/react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { Empty } from "@/components/page-state";
import { Shell } from "@/components/shell";
import { FailedMessageRecovery, type FailedMessageRecoveryState } from "@/components/failed-message-recovery";
import { api } from "@/lib/api";
import {
  archiveConnection,
  createConnection,
  listConnections,
  promoteConnection,
  reconnectConnection,
  renameConnection,
  type ConnectionLimits,
  type ConnectionState,
  type ConnectionsResponse
} from "@/lib/connections";
import { usePermission } from "@/lib/use-permission";

const POLL_INTERVAL_MS = 3_000;
const MAX_BACKOFF_MS = 30_000;

function errorMessage(value: unknown, fallback: string) {
  return value instanceof Error && value.message ? value.message : fallback;
}

type ConfirmedAction = {
  kind: "promote" | "archive";
  connection: ConnectionState;
};

export default function Connection() {
  const canManageConnection = usePermission("connection.manage");
  const [connections, setConnections] = useState<ConnectionState[]>([]);
  const [limits, setLimits] = useState<ConnectionLimits>({ used: 0, max: null });
  const [loaded, setLoaded] = useState(false);
  const [pollingError, setPollingError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [retryDelayMs, setRetryDelayMs] = useState(0);
  const [pollingRetrying, setPollingRetrying] = useState(false);
  const [confirmingReconnect, setConfirmingReconnect] = useState(false);
  const [reconnectTarget, setReconnectTarget] = useState<ConnectionState | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [confirmedAction, setConfirmedAction] = useState<ConfirmedAction | null>(null);
  const [actingConnectionId, setActingConnectionId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [recovery, setRecovery] = useState<FailedMessageRecoveryState>({ available: 0, ambiguous: 0, has_connected_session: false, legacy_unrecoverable: 0, oldest_at: null });
  const [confirmingRecovery, setConfirmingRecovery] = useState(false);
  const [recoveringMessages, setRecoveringMessages] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const retryPollingRef = useRef<() => void>(() => undefined);
  const resetPollingRef = useRef<() => void>(() => undefined);
  const pollingPausedRef = useRef(false);
  const reconnectTriggerRef = useRef<HTMLButtonElement>(null);
  const actionTriggerRef = useRef<HTMLButtonElement>(null);
  const connection = connections[0] ?? null;

  function applyConnections(response: ConnectionsResponse) {
    setConnections(response.connections);
    setLimits(response.limits);
    setLoaded(true);
    setPollingError("");
    setRetryDelayMs(0);
    setLastUpdatedAt(new Date());
  }

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let inFlight = false;
    let consecutiveFailures = 0;

    const clearTimer = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };

    const schedule = (delay: number) => {
      clearTimer();
      if (active) timer = window.setTimeout(() => void load(false), delay);
    };

    const load = async (manual: boolean) => {
      if (inFlight) return;
      if (pollingPausedRef.current) {
        schedule(POLL_INTERVAL_MS);
        return;
      }
      inFlight = true;
      if (manual) setPollingRetrying(true);
      try {
        const response = await listConnections();
        if (!active || pollingPausedRef.current) return;
        consecutiveFailures = 0;
        applyConnections(response);
        try {
          const recoveryResponse = await api<{ recovery: FailedMessageRecoveryState }>(
            "/connection/failed-messages",
            undefined,
            { reportErrors: false }
          );
          if (active && !pollingPausedRef.current) setRecovery(recoveryResponse.recovery);
        } catch {
          // Message recovery is optional and must not hide healthy WhatsApp connections.
        }
        schedule(POLL_INTERVAL_MS);
      } catch (requestError) {
        if (!active || pollingPausedRef.current) return;
        consecutiveFailures += 1;
        const delay = Math.min(POLL_INTERVAL_MS * (2 ** (consecutiveFailures - 1)), MAX_BACKOFF_MS);
        setPollingError(errorMessage(requestError, "Não foi possível atualizar o estado das conexões."));
        setRetryDelayMs(delay);
        schedule(delay);
      } finally {
        inFlight = false;
        if (active && manual) setPollingRetrying(false);
        if (active && pollingPausedRef.current) schedule(POLL_INTERVAL_MS);
      }
    };

    retryPollingRef.current = () => {
      clearTimer();
      void load(true);
    };
    resetPollingRef.current = () => {
      consecutiveFailures = 0;
      setRetryDelayMs(0);
      clearTimer();
      schedule(POLL_INTERVAL_MS);
    };

    void load(false);
    return () => {
      active = false;
      clearTimer();
      retryPollingRef.current = () => undefined;
      resetPollingRef.current = () => undefined;
    };
  }, []);

  function openReconnect(connectionToReconnect: ConnectionState, trigger: HTMLButtonElement) {
    reconnectTriggerRef.current = trigger;
    setReconnectTarget(connectionToReconnect);
    setActionError("");
    setNotice("");
    setConfirmingRecovery(false);
    setConfirmedAction(null);
    setConfirmingReconnect(true);
  }

  function closeReconnectConfirmation() {
    setConfirmingReconnect(false);
    setReconnectTarget(null);
    setActionError("");
    window.requestAnimationFrame(() => reconnectTriggerRef.current?.focus());
  }

  async function reconnect() {
    if (!canManageConnection || reconnecting || !reconnectTarget) return;
    pollingPausedRef.current = true;
    setReconnecting(true);
    setActionError("");
    setNotice("");
    let refreshAfterAction = false;
    try {
      await reconnectConnection(reconnectTarget.id);
      setConfirmingReconnect(false);
      setReconnectTarget(null);
      setNotice("Reconexão solicitada. Aguardando a nova sessão ficar disponível.");
      try {
        applyConnections(await listConnections());
      } catch (requestError) {
        setPollingError(errorMessage(requestError, "A reconexão foi solicitada, mas o estado atualizado ainda não está disponível."));
        setRetryDelayMs(POLL_INTERVAL_MS);
        refreshAfterAction = true;
      }
    } catch (requestError) {
      setActionError(errorMessage(requestError, "Não foi possível reconectar a sessão."));
    } finally {
      pollingPausedRef.current = false;
      setReconnecting(false);
      if (refreshAfterAction) retryPollingRef.current();
      else resetPollingRef.current();
    }
  }

  async function recoverFailedMessages() {
    if (!canManageConnection || recoveringMessages || !recovery.has_connected_session) return;
    setRecoveringMessages(true);
    setRecoveryError("");
    setNotice("");
    try {
      const result = await api<{ sent: number; failed: number; ambiguous: number; remaining: number }>("/connection/failed-messages/resend", { method: "POST" });
      const refreshed = await api<{ recovery: FailedMessageRecoveryState }>("/connection/failed-messages");
      setRecovery(refreshed.recovery);
      setConfirmingRecovery(false);
      setNotice(result.sent === 1
        ? "1 mensagem foi reenviada e registrada na conversa."
        : `${result.sent} mensagens foram reenviadas e registradas nas conversas.`);
      if (result.failed > 0) setRecoveryError(`${result.failed} mensagens ainda não puderam ser reenviadas.`);
      if (result.ambiguous > 0) setRecoveryError(`${result.ambiguous} envios foram aceitos, mas precisam de revisão no histórico e não serão reenviados.`);
    } catch (requestError) {
      setRecoveryError(errorMessage(requestError, "Não foi possível reenviar as mensagens."));
    } finally {
      setRecoveringMessages(false);
    }
  }

  async function addConnection() {
    const label = newLabel.trim();
    if (!canManageConnection || adding || !label) return;
    pollingPausedRef.current = true;
    setAdding(true);
    setActionError("");
    setNotice("");
    try {
      await createConnection(label);
      setAddOpen(false);
      setNewLabel("");
      setNotice(`Conexão “${label}” adicionada. Leia o QR Code quando ele estiver disponível.`);
      applyConnections(await listConnections());
    } catch (requestError) {
      setActionError(errorMessage(requestError, "Não foi possível adicionar a conexão."));
    } finally {
      pollingPausedRef.current = false;
      setAdding(false);
      resetPollingRef.current();
    }
  }

  async function saveRename(connectionToRename: ConnectionState) {
    const label = editLabel.trim();
    if (!canManageConnection || actingConnectionId || !label) return;
    pollingPausedRef.current = true;
    setActingConnectionId(connectionToRename.id);
    setActionError("");
    setNotice("");
    try {
      await renameConnection(connectionToRename.id, label);
      setEditingId(null);
      setEditLabel("");
      setNotice("Rótulo atualizado.");
      applyConnections(await listConnections());
    } catch (requestError) {
      setActionError(errorMessage(requestError, "Não foi possível renomear a conexão."));
    } finally {
      pollingPausedRef.current = false;
      setActingConnectionId(null);
      resetPollingRef.current();
    }
  }

  function requestConfirmedAction(action: ConfirmedAction, trigger: HTMLButtonElement) {
    actionTriggerRef.current = trigger;
    setActionError("");
    setNotice("");
    setConfirmingRecovery(false);
    setConfirmingReconnect(false);
    setReconnectTarget(null);
    setConfirmedAction(action);
  }

  function closeConfirmedAction() {
    setConfirmedAction(null);
    setActionError("");
    window.requestAnimationFrame(() => actionTriggerRef.current?.focus());
  }

  async function runConfirmedAction() {
    if (!confirmedAction || actingConnectionId) return;
    const { kind, connection: target } = confirmedAction;
    pollingPausedRef.current = true;
    setActingConnectionId(target.id);
    setActionError("");
    setNotice("");
    try {
      if (kind === "promote") {
        await promoteConnection(target.id);
        setNotice(`“${target.label}” agora é a conexão principal.`);
      } else {
        await archiveConnection(target.id);
        setNotice(`Conexão “${target.label}” removida.`);
      }
      setConfirmedAction(null);
      applyConnections(await listConnections());
    } catch (requestError) {
      setActionError(errorMessage(requestError, kind === "promote" ? "Não foi possível tornar esta conexão principal." : "Não foi possível remover a conexão."));
    } finally {
      pollingPausedRef.current = false;
      setActingConnectionId(null);
      resetPollingRef.current();
    }
  }

  const degraded = loaded && Boolean(pollingError);
  const retryDelaySeconds = Math.max(1, Math.ceil(retryDelayMs / 1_000));
  const atLimit = limits.max !== null && limits.used >= limits.max;
  const limitTitle = atLimit ? `Seu plano permite até ${limits.max} conexões de WhatsApp.` : undefined;
  const connectedCount = connections.filter((item) => item.status === "connected").length;

  return (
    <Shell>
      <header className="pagehead">
        <div><h1>Conexão</h1><p>Vincule o WhatsApp usado pelo agente.</p></div>
        <div className="flex flex-wrap items-center gap-3">
          {loaded && connections.length ? (
            <span className="mono rounded-md border border-[var(--border-ai)] px-3 py-2 text-[11px] text-[var(--accent-soft)]">
              {connectedCount} de {connections.length} conectado{connections.length === 1 ? "" : "s"}
            </span>
          ) : null}
          {canManageConnection ? (
            <button
              type="button"
              className="btn"
              disabled={atLimit || adding}
              title={limitTitle}
              onClick={() => { setActionError(""); setNotice(""); setAddOpen(true); }}
            >
              <Plus size={16} aria-hidden="true" />
              Adicionar número
            </button>
          ) : <span className="text-sm text-[var(--muted)]" role="status">Acesso somente leitura. O gerenciamento das conexões está indisponível.</span>}
        </div>
      </header>

      {addOpen && canManageConnection ? (
        <section className="card mb-5 grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end" role="dialog" aria-labelledby="add-connection-title">
          <label className="field">
            <span id="add-connection-title" className="label">Rótulo do número</span>
            <input className="input" maxLength={60} value={newLabel} autoFocus onChange={(event) => setNewLabel(event.target.value)} placeholder="Ex.: Comercial" aria-label="Rótulo do número" />
          </label>
          <div className="flex flex-wrap gap-2 md:justify-end">
            <button type="button" className="btn" disabled={adding} onClick={() => { setAddOpen(false); setNewLabel(""); setActionError(""); }}>Cancelar</button>
            <button type="button" className="btn primary" disabled={adding || !newLabel.trim()} onClick={() => void addConnection()}>{adding ? "Adicionando…" : "Adicionar conexão"}</button>
          </div>
          {actionError ? <p className="error md:col-span-2" role="alert">{actionError}</p> : null}
        </section>
      ) : null}

      {confirmingReconnect && canManageConnection && reconnectTarget ? (
        <section
          id="connection-reconnect-confirmation"
          className="mb-5 grid gap-4 border-y border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
          role="alertdialog"
          aria-labelledby="connection-reconnect-title"
          aria-describedby="connection-reconnect-description"
        >
          <div className="flex items-start gap-3">
            <Warning className="mt-0.5 shrink-0 text-[var(--warn)]" size={20} aria-hidden="true" />
            <div>
              <strong id="connection-reconnect-title" className="block text-sm text-[var(--text)]">Confirmar reconexão de “{reconnectTarget.label}”?</strong>
              <p id="connection-reconnect-description" className="mt-1 max-w-[65ch] text-sm leading-relaxed text-[var(--warn-muted)]">
                A sessão atual poderá ser interrompida e um novo QR Code será gerado. O atendimento automático pode ficar indisponível até a leitura do novo código.
              </p>
              {actionError ? <p className="error mt-3" role="alert">{actionError}</p> : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 md:justify-end">
            <button type="button" className="btn" autoFocus disabled={reconnecting} onClick={closeReconnectConfirmation}>Manter sessão atual</button>
            <button type="button" className="btn warn" disabled={reconnecting} onClick={() => void reconnect()}>
              <ArrowsClockwise size={16} className={reconnecting ? "animate-spin" : ""} aria-hidden="true" />
              {reconnecting ? "Reconectando…" : "Confirmar reconexão"}
            </button>
          </div>
        </section>
      ) : null}

      {confirmedAction ? (
        <section className="mb-5 grid gap-4 border-y border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center" role="alertdialog" aria-labelledby="connection-action-title" aria-describedby="connection-action-description">
          <div className="flex items-start gap-3">
            <Warning className="mt-0.5 shrink-0 text-[var(--warn)]" size={20} aria-hidden="true" />
            <div>
              <strong id="connection-action-title" className="block text-sm text-[var(--text)]">
                {confirmedAction.kind === "promote" ? `Tornar “${confirmedAction.connection.label}” principal?` : `Remover “${confirmedAction.connection.label}”?`}
              </strong>
              <p id="connection-action-description" className="mt-1 max-w-[65ch] text-sm leading-relaxed text-[var(--warn-muted)]">
                {confirmedAction.kind === "promote"
                  ? "Os fluxos sem número escolhido passarão a usar esta conexão."
                  : "A conexão será arquivada, mas o histórico das conversas continuará disponível."}
              </p>
              {actionError ? <p className="error mt-3" role="alert">{actionError}</p> : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 md:justify-end">
            <button type="button" className="btn" autoFocus disabled={Boolean(actingConnectionId)} onClick={closeConfirmedAction}>Cancelar</button>
            <button type="button" className="btn warn" disabled={Boolean(actingConnectionId)} onClick={() => void runConfirmedAction()}>
              {actingConnectionId ? "Salvando…" : confirmedAction.kind === "promote" ? "Tornar principal" : "Remover conexão"}
            </button>
          </div>
        </section>
      ) : null}

      {notice ? <p className="accent mb-4 text-sm" role="status" aria-live="polite">{notice}</p> : null}
      {actionError && !addOpen && !confirmingReconnect && !confirmedAction ? <p className="error mb-4" role="alert">{actionError}</p> : null}

      {loaded && connection ? (
        <FailedMessageRecovery
          recovery={recovery}
          canManage={canManageConnection}
          connected={recovery.has_connected_session}
          recovering={recoveringMessages}
          confirming={confirmingRecovery}
          error={recoveryError}
          onConfirm={() => { setRecoveryError(""); setNotice(""); setConfirmingReconnect(false); setConfirmingRecovery(true); }}
          onCancel={() => { setRecoveryError(""); setConfirmingRecovery(false); }}
          onRecover={() => void recoverFailedMessages()}
        />
      ) : null}

      {degraded ? (
        <section className="mb-5 flex flex-wrap items-center justify-between gap-4 border-y border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-4" role="status" aria-live="polite">
          <div className="flex min-w-0 items-start gap-3">
            <Warning className="mt-0.5 shrink-0 text-[var(--warn)]" size={19} aria-hidden="true" />
            <div>
              <strong className="block text-sm text-[var(--warn)]">Atualização temporariamente indisponível</strong>
              <p className="mt-1 text-sm leading-relaxed text-[var(--warn-muted)]">
                Exibindo o último estado válido{lastUpdatedAt ? `, atualizado às ${lastUpdatedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}.
                {retryDelayMs ? ` Nova tentativa automática em aproximadamente ${retryDelaySeconds}s.` : ""}
              </p>
              <p className="mono mt-1 text-[10px] text-[var(--warn-muted)]">{pollingError}</p>
            </div>
          </div>
          <button type="button" className="btn warn" disabled={pollingRetrying || reconnecting} onClick={() => retryPollingRef.current()}>
            <ArrowsClockwise size={16} className={pollingRetrying ? "animate-spin" : ""} aria-hidden="true" />
            {pollingRetrying ? "Atualizando…" : "Tentar agora"}
          </button>
        </section>
      ) : null}

      {!loaded && !pollingError ? (
        <div className="grid gap-3 py-6" aria-busy="true" aria-label="Carregando conexões" role="status">
          <span className="sr-only">Carregando conexões</span>
          <div className="skeleton h-96" />
        </div>
      ) : null}

      {!loaded && pollingError ? (
        <section className="grid justify-items-start gap-3 border-y border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-5 text-[var(--warn)]" role="alert">
          <div className="flex items-start gap-3">
            <Warning className="mt-0.5 shrink-0" size={20} aria-hidden="true" />
            <div>
              <strong className="block text-sm">Não foi possível carregar as conexões</strong>
              <p className="mt-1 text-sm text-[var(--warn-muted)]">{pollingError}</p>
              {retryDelayMs ? <p className="sub">Nova tentativa automática em aproximadamente {retryDelaySeconds}s.</p> : null}
            </div>
          </div>
          <button type="button" className="btn warn" disabled={pollingRetrying} onClick={() => retryPollingRef.current()}>
            <ArrowsClockwise size={16} className={pollingRetrying ? "animate-spin" : ""} aria-hidden="true" />
            {pollingRetrying ? "Tentando novamente…" : "Tentar novamente"}
          </button>
        </section>
      ) : null}

      {loaded && connections.length === 0 ? <Empty>Nenhuma sessão de WhatsApp configurada.</Empty> : null}

      {loaded && connections.length ? (
        <div className="grid gap-8">
          {connections.map((item) => {
            const pending = item.status === "qr_pending";
            const busy = actingConnectionId === item.id || (reconnecting && reconnectTarget?.id === item.id);
            return (
              <article key={item.id} role="group" aria-label={`Conexão ${item.label}`} className="grid gap-4">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] pb-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h2 className="truncate text-lg font-semibold text-[var(--text)]">{item.label}</h2>
                    {item.is_primary ? <span className="mono rounded border border-[var(--border-ai)] bg-[var(--accent-bg)] px-2 py-0.5 text-[10px] text-[var(--accent-soft)]">Principal</span> : null}
                    <span className={`mono rounded-md border px-2 py-1 text-[10px] ${item.status === "connected" ? "border-[var(--border-ai)] text-[var(--accent-soft)]" : "border-[var(--warn-border)] bg-[var(--warn-bg)] text-[var(--warn)]"}`}>status: {item.status}</span>
                  </div>
                  {canManageConnection ? (
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className="btn" disabled={busy} onClick={() => { setEditingId(item.id); setEditLabel(item.label); setActionError(""); setNotice(""); }}><PencilSimple size={15} aria-hidden="true" />Renomear</button>
                      {!item.is_primary ? <button type="button" className="btn" disabled={busy} onClick={(event) => requestConfirmedAction({ kind: "promote", connection: item }, event.currentTarget)}><Star size={15} aria-hidden="true" />Tornar principal</button> : null}
                      <button type="button" className="btn" disabled={busy} aria-expanded={confirmingReconnect && reconnectTarget?.id === item.id} aria-controls="connection-reconnect-confirmation" onClick={(event) => openReconnect(item, event.currentTarget)}><ArrowsClockwise size={15} aria-hidden="true" />Reconectar</button>
                      <button type="button" className="btn warn" disabled={busy} onClick={(event) => requestConfirmedAction({ kind: "archive", connection: item }, event.currentTarget)}><Trash size={15} aria-hidden="true" />Remover</button>
                    </div>
                  ) : null}
                </div>

                {editingId === item.id ? (
                  <section className="card grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end" role="dialog" aria-label={`Renomear conexão ${item.label}`}>
                    <label className="field"><span className="label">Novo rótulo</span><input className="input" maxLength={60} value={editLabel} autoFocus onChange={(event) => setEditLabel(event.target.value)} /></label>
                    <div className="flex flex-wrap gap-2 md:justify-end"><button type="button" className="btn" disabled={busy} onClick={() => { setEditingId(null); setActionError(""); }}>Cancelar</button><button type="button" className="btn primary" disabled={busy || !editLabel.trim()} onClick={() => void saveRename(item)}>{busy ? "Salvando…" : "Salvar rótulo"}</button></div>
                  </section>
                ) : null}

                <div className="grid gap-6 lg:grid-cols-[auto_1fr]">
                  <section className="card grid min-h-[430px] w-full place-items-center p-7 lg:w-[358px]">
                    {pending && item.qr_code ? (
                      <div className="text-center">
                        <div className="rounded-[10px] bg-white p-4"><QRCodeSVG value={item.qr_code} title={`QR Code de ${item.label}`} size={268} fgColor="#0b0e0d" bgColor="#ffffff" /></div>
                        <p className="mt-5 flex items-center justify-center gap-2 text-[var(--body)]"><i className="dot warn" />Aguardando leitura</p>
                        <p className="mono mt-1 text-[10px] text-[var(--faint)]">QR renovado automaticamente</p>
                      </div>
                    ) : pending ? (
                      <div className="text-center" aria-busy="true" role="status">
                        <ArrowsClockwise size={42} className="mx-auto animate-spin text-[var(--accent)]" aria-hidden="true" />
                        <h3 className="mt-4 text-lg font-semibold">Gerando novo QR Code</h3>
                        <p className="sub">Aguarde a atualização automática da sessão.</p>
                      </div>
                    ) : item.status === "connected" ? (
                      <div className="text-center">
                        <CheckCircle size={52} className="mx-auto text-[var(--accent)]" aria-hidden="true" />
                        <h3 className="mt-4 text-lg font-semibold">WhatsApp conectado</h3>
                        <p className="mono mt-2 text-xs text-[var(--muted)]">{item.phone_number}</p>
                        <p className="sub">Conectado desde {item.last_connected_at ? new Date(item.last_connected_at).toLocaleString("pt-BR") : "data indisponível"}</p>
                      </div>
                    ) : (
                      <div className="text-center">
                        <Warning size={48} className="mx-auto text-[var(--warn)]" aria-hidden="true" />
                        <h3 className="mt-4 text-lg font-semibold">Sessão desconectada</h3>
                        <p className="sub">{canManageConnection ? "Use “Reconectar” para gerar um novo QR Code." : "Solicite a uma pessoa com permissão de gerenciamento que gere um novo QR Code."}</p>
                        {item.disconnected_reason ? <p className="mono mt-3 text-[10px] text-[var(--faint)]">Motivo: {item.disconnected_reason}</p> : null}
                      </div>
                    )}
                  </section>
                  <aside className="grid content-start gap-4">
                    <section className="card">
                      <div className="cardtitle">Como conectar</div>
                      <ol className="grid gap-5">
                        {["Abra o WhatsApp no celular e acesse Aparelhos conectados.", "Toque em Conectar um aparelho.", "Aponte a câmera para o QR Code ao lado."].map((text, index) => (
                          <li className="flex gap-3 text-[var(--body)]" key={text}><b className="grid size-[22px] shrink-0 place-items-center rounded-full bg-[var(--active)] text-xs text-[var(--accent-soft)]">{index + 1}</b><span>{text}</span></li>
                        ))}
                      </ol>
                      <p className="sub mt-5 border-t border-[var(--border)] pt-4">O celular continua funcionando normalmente. O atendente pode responder por ele quando a IA estiver pausada.</p>
                    </section>
                    <section className="card">
                      <div className="cardtitle">Última sessão</div>
                      <dl className="grid gap-3 text-sm">
                        <div><dt className="label">Número</dt><dd className="mono mt-1 text-xs">{item.phone_number ?? "Ainda não identificado"}</dd></div>
                        <div><dt className="label">Criada em</dt><dd className="mt-1">{new Date(item.created_at).toLocaleString("pt-BR")}</dd></div>
                      </dl>
                    </section>
                    <section className="card warn flex gap-3 text-sm text-[var(--warn-muted)]"><Warning size={20} className="shrink-0 text-[var(--warn)]" aria-hidden="true" /><p>Conexão não-oficial: evite disparos em massa e mantenha um padrão de conversa humano.</p></section>
                  </aside>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
    </Shell>
  );
}
