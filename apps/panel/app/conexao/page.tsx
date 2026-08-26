"use client";

import { ArrowsClockwise, CheckCircle, Warning } from "@phosphor-icons/react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { Empty } from "@/components/page-state";
import { Shell } from "@/components/shell";
import { FailedMessageRecovery, type FailedMessageRecoveryState } from "@/components/failed-message-recovery";
import { api } from "@/lib/api";
import { usePermission } from "@/lib/use-permission";

interface ConnectionState {
  id: string;
  phone_number: string | null;
  status: "qr_pending" | "connected" | "disconnected" | "banned";
  qr_code: string | null;
  last_connected_at: string | null;
  disconnected_reason: string | null;
  created_at: string;
}

const POLL_INTERVAL_MS = 3_000;
const MAX_BACKOFF_MS = 30_000;

function errorMessage(value: unknown, fallback: string) {
  return value instanceof Error && value.message ? value.message : fallback;
}

export default function Connection() {
  const canManageConnection = usePermission("connection.manage");
  const [connection, setConnection] = useState<ConnectionState | null>();
  const [loaded, setLoaded] = useState(false);
  const [pollingError, setPollingError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [retryDelayMs, setRetryDelayMs] = useState(0);
  const [pollingRetrying, setPollingRetrying] = useState(false);
  const [confirmingReconnect, setConfirmingReconnect] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [recovery, setRecovery] = useState<FailedMessageRecoveryState>({ available: 0, ambiguous: 0, has_connected_session: false, legacy_unrecoverable: 0, oldest_at: null });
  const [confirmingRecovery, setConfirmingRecovery] = useState(false);
  const [recoveringMessages, setRecoveringMessages] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const retryPollingRef = useRef<() => void>(() => undefined);
  const resetPollingRef = useRef<() => void>(() => undefined);
  const pollingPausedRef = useRef(false);
  const reconnectTriggerRef = useRef<HTMLButtonElement>(null);

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
        const [response, recoveryResponse] = await Promise.all([
          api<{ connection: ConnectionState | null }>("/connection"),
          api<{ recovery: FailedMessageRecoveryState }>("/connection/failed-messages")
        ]);
        if (!active || pollingPausedRef.current) return;
        consecutiveFailures = 0;
        setConnection(response.connection);
        setRecovery(recoveryResponse.recovery);
        setLoaded(true);
        setPollingError("");
        setRetryDelayMs(0);
        setLastUpdatedAt(new Date());
        schedule(POLL_INTERVAL_MS);
      } catch (requestError) {
        if (!active || pollingPausedRef.current) return;
        consecutiveFailures += 1;
        const delay = Math.min(POLL_INTERVAL_MS * (2 ** (consecutiveFailures - 1)), MAX_BACKOFF_MS);
        setPollingError(errorMessage(requestError, "Não foi possível atualizar o estado da conexão."));
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

  function closeReconnectConfirmation() {
    setConfirmingReconnect(false);
    setActionError("");
    window.requestAnimationFrame(() => reconnectTriggerRef.current?.focus());
  }

  async function reconnect() {
    if (!canManageConnection || reconnecting) return;
    pollingPausedRef.current = true;
    setReconnecting(true);
    setActionError("");
    setNotice("");
    let refreshAfterAction = false;
    try {
      await api("/connection/reconnect", { method: "POST" });
      setConfirmingReconnect(false);
      setNotice("Troca solicitada. Aguardando a nova sessão ficar disponível.");
      try {
        const response = await api<{ connection: ConnectionState | null }>("/connection");
        setConnection(response.connection);
        setLoaded(true);
        setPollingError("");
        setRetryDelayMs(0);
        setLastUpdatedAt(new Date());
      } catch (requestError) {
        setPollingError(errorMessage(requestError, "A troca foi solicitada, mas o estado atualizado ainda não está disponível."));
        setRetryDelayMs(POLL_INTERVAL_MS);
        refreshAfterAction = true;
      }
    } catch (requestError) {
      setActionError(errorMessage(requestError, "Não foi possível trocar a sessão."));
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

  const pending = connection?.status === "qr_pending";
  const degraded = loaded && Boolean(pollingError);
  const retryDelaySeconds = Math.max(1, Math.ceil(retryDelayMs / 1_000));

  return (
    <Shell>
      <header className="pagehead">
        <div><h1>Conexão</h1><p>Vincule o WhatsApp usado pelo agente.</p></div>
        <div className="flex flex-wrap items-center gap-3">
          {connection ? (
            <span className={`mono rounded-md border px-3 py-2 text-[11px] ${connection.status === "connected" ? "border-[var(--border-ai)] text-[var(--accent-soft)]" : "border-[var(--warn-border)] bg-[var(--warn-bg)] text-[var(--warn)]"}`}>
              status: {connection.status}
            </span>
          ) : null}
          {connection && canManageConnection ? (
            <button
              ref={reconnectTriggerRef}
              type="button"
              className="btn"
              disabled={reconnecting}
              aria-expanded={confirmingReconnect}
              aria-controls="connection-reconnect-confirmation"
              onClick={() => { setActionError(""); setNotice(""); setConfirmingRecovery(false); setConfirmingReconnect(true); }}
            >
              <ArrowsClockwise size={16} aria-hidden="true" />
              Trocar número ou sessão
            </button>
          ) : connection ? (
            <span className="text-sm text-[var(--muted)]" role="status">Acesso somente leitura. A troca de sessão está indisponível.</span>
          ) : null}
        </div>
      </header>

      {confirmingReconnect && canManageConnection ? (
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
              <strong id="connection-reconnect-title" className="block text-sm text-[var(--text)]">Confirmar troca de número ou sessão?</strong>
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
              {reconnecting ? "Trocando sessão…" : "Confirmar troca"}
            </button>
          </div>
        </section>
      ) : null}

      {notice ? <p className="accent mb-4 text-sm" role="status" aria-live="polite">{notice}</p> : null}

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
        <div className="grid gap-3 py-6" aria-busy="true" aria-label="Carregando conexão" role="status">
          <span className="sr-only">Carregando conexão</span>
          <div className="skeleton h-96" />
        </div>
      ) : null}

      {!loaded && pollingError ? (
        <section className="grid justify-items-start gap-3 border-y border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-5 text-[var(--warn)]" role="alert">
          <div className="flex items-start gap-3">
            <Warning className="mt-0.5 shrink-0" size={20} aria-hidden="true" />
            <div>
              <strong className="block text-sm">Não foi possível carregar a conexão</strong>
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

      {loaded && !connection ? <Empty>Nenhuma sessão de WhatsApp configurada.</Empty> : null}

      {loaded && connection ? (
        <div className="grid gap-6 lg:grid-cols-[auto_1fr]">
          <section className="card grid min-h-[430px] w-full place-items-center p-7 lg:w-[358px]">
            {pending && connection.qr_code ? (
              <div className="text-center">
                <div className="rounded-[10px] bg-white p-4"><QRCodeSVG value={connection.qr_code} size={268} fgColor="#0b0e0d" bgColor="#ffffff" /></div>
                <p className="mt-5 flex items-center justify-center gap-2 text-[var(--body)]"><i className="dot warn" />Aguardando leitura</p>
                <p className="mono mt-1 text-[10px] text-[var(--faint)]">QR renovado automaticamente</p>
              </div>
            ) : pending ? (
              <div className="text-center" aria-busy="true" role="status">
                <ArrowsClockwise size={42} className="mx-auto animate-spin text-[var(--accent)]" aria-hidden="true" />
                <h2 className="mt-4 text-lg font-semibold">Gerando novo QR Code</h2>
                <p className="sub">Aguarde a atualização automática da sessão.</p>
              </div>
            ) : connection.status === "connected" ? (
              <div className="text-center">
                <CheckCircle size={52} className="mx-auto text-[var(--accent)]" aria-hidden="true" />
                <h2 className="mt-4 text-lg font-semibold">WhatsApp conectado</h2>
                <p className="mono mt-2 text-xs text-[var(--muted)]">{connection.phone_number}</p>
                <p className="sub">Conectado desde {connection.last_connected_at ? new Date(connection.last_connected_at).toLocaleString("pt-BR") : "data indisponível"}</p>
              </div>
            ) : (
              <div className="text-center">
                <Warning size={48} className="mx-auto text-[var(--warn)]" aria-hidden="true" />
                <h2 className="mt-4 text-lg font-semibold">Sessão desconectada</h2>
                <p className="sub">
                  {canManageConnection
                    ? "Use “Trocar número ou sessão” para gerar um novo QR Code."
                    : "Solicite a uma pessoa com permissão de gerenciamento que gere um novo QR Code."}
                </p>
                {connection.disconnected_reason ? <p className="mono mt-3 text-[10px] text-[var(--faint)]">Motivo: {connection.disconnected_reason}</p> : null}
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
                <div><dt className="label">Número</dt><dd className="mono mt-1 text-xs">{connection.phone_number ?? "Ainda não identificado"}</dd></div>
                <div><dt className="label">Criada em</dt><dd className="mt-1">{new Date(connection.created_at).toLocaleString("pt-BR")}</dd></div>
              </dl>
            </section>
            <section className="card warn flex gap-3 text-sm text-[var(--warn-muted)]"><Warning size={20} className="shrink-0 text-[var(--warn)]" aria-hidden="true" /><p>Conexão não-oficial: evite disparos em massa e mantenha um padrão de conversa humano.</p></section>
          </aside>
        </div>
      ) : null}
    </Shell>
  );
}
