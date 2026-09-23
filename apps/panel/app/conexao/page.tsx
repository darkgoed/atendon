"use client";

import { ArrowsClockwise, CheckCircle, DotsThreeVertical, PencilSimple, Plus, Star, Trash, Warning, X } from "@phosphor-icons/react";
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
  type ConnectionsResponse,
  getInstagramStatus,
  type InstagramStatus
} from "@/lib/connections";
import { usePermission } from "@/lib/use-permission";
import { Button } from "@/components/ui/button";
import { IconButton, SaveButton, SaveToast, useSaveFeedback } from "@/components/ui";
import { PageHeader } from "@/components/ui/layout";
import { PopoverMenu } from "@/components/popover-menu";
import { InstagramConnections } from "@/components/instagram-connections";
import styles from "../channels-ai.module.css";

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
  const save = useSaveFeedback();
  const [addOpen, setAddOpen] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [recovery, setRecovery] = useState<FailedMessageRecoveryState>({ available: 0, ambiguous: 0, has_connected_session: false, legacy_unrecoverable: 0, oldest_at: null });
  const [confirmingRecovery, setConfirmingRecovery] = useState(false);
  const [recoveringMessages, setRecoveringMessages] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const [instagramStatus, setInstagramStatus] = useState<InstagramStatus | null>(null);
  const [qrColors, setQrColors] = useState<{ foreground: string; background: string }>({
    foreground: "var(--text)",
    background: "var(--surface)"
  });
  const retryPollingRef = useRef<() => void>(() => undefined);
  const resetPollingRef = useRef<() => void>(() => undefined);
  const pollingPausedRef = useRef(false);
  const reconnectTriggerRef = useRef<HTMLButtonElement>(null);
  const actionTriggerRef = useRef<HTMLButtonElement>(null);
  const whatsappConnections = connections.filter((item) => (item.channel ?? "whatsapp") === "whatsapp");
  const connection = whatsappConnections[0] ?? null;

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

  useEffect(() => {
    const root = document.documentElement;
    const syncQrColors = () => {
      const computed = getComputedStyle(root);
      const foreground = computed.getPropertyValue("--text").trim();
      const background = computed.getPropertyValue("--surface").trim();
      if (foreground && background) setQrColors({ foreground, background });
    };
    syncQrColors();
    const observer = new MutationObserver(syncQrColors);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    void getInstagramStatus().then((value) => { if (active) setInstagramStatus(value); }).catch(() => undefined);
    const params = new URLSearchParams(window.location.search);
    const result = params.get("instagram");
    if (result === "connected") setNotice("Instagram conectado com sucesso.");
    if (result === "error") {
      // O backend passa o code do erro real (ex.: conta já conectada em
      // outro workspace, ou faltando permissão obrigatória) em vez de uma
      // mensagem genérica que escondia a causa e levava a tentar de novo
      // sem nunca resolver.
      const reason = params.get("instagram_reason");
      setActionError(
        reason === "INSTAGRAM_ACCOUNT_ALREADY_CONNECTED"
          ? "Esta conta do Instagram já está conectada em outro workspace do AtendON. Desconecte-a lá antes de conectar aqui."
          : reason === "INSTAGRAM_APP_ACCESS_NOT_GRANTED"
          ? "A Meta recusou o acesso do AtendON a esta conta. A autorização funcionou, mas o app ainda não tem permissão para atendê-la: adicione a conta como testadora do app no painel da Meta ou conclua a aprovação de Acesso Avançado. Reautorizar não resolve enquanto isso."
          : reason === "INSTAGRAM_REQUIRED_SCOPE_MISSING"
          ? "A autorização do Instagram não concedeu todas as permissões necessárias. Ao autorizar, marque todas as opções solicitadas e tente novamente."
          : "Não foi possível concluir a autorização do Instagram. Verifique as permissões e tente novamente."
      );
    }
    return () => { active = false; };
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
      save.markDone();
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
      save.markDone();
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
  const connectedCount = whatsappConnections.filter((item) => item.status === "connected").length;

  return (
    <Shell><div className={`${styles.channelsAiPage} channels-ai-page`}>
      <PageHeader
        title="Conexão"
        actions={
          <div className="flex flex-wrap items-center gap-3">
          {loaded && whatsappConnections.length ? (
            <span className="mono rounded-md border border-[var(--primary-border)] px-3 py-2 type-caption text-[var(--primary-text)]">
              {connectedCount} de {whatsappConnections.length} conectado{whatsappConnections.length === 1 ? "" : "s"}
            </span>
          ) : null}
          {canManageConnection ? (
            <Button
              type="button"
              className=""
              disabled={atLimit || adding}
              title={limitTitle}
              onClick={() => { setActionError(""); setNotice(""); setAddOpen(true); }}
            >
              <Plus size={16} aria-hidden="true" />
              Adicionar número
            </Button>
          ) : <span className="text-sm text-[var(--text-secondary)]" role="status">Acesso somente leitura. O gerenciamento das conexões está indisponível.</span>}
          </div>
        }
      />

      {addOpen && canManageConnection ? (
        <section className="channels-ai-section channels-ai-form-grid mb-5" role="dialog" aria-labelledby="add-connection-title">
          <label className="field">
            <span id="add-connection-title" className="label">Rótulo do número</span>
            <input className="input" maxLength={60} value={newLabel} autoFocus onChange={(event) => setNewLabel(event.target.value)} placeholder="Ex.: Comercial" aria-label="Rótulo do número" />
          </label>
          <div className="flex flex-wrap gap-2 md:justify-end">
            <IconButton type="button" label="Cancelar" size="sm" disabled={adding} onClick={() => { setAddOpen(false); setNewLabel(""); setActionError(""); }}><X size={15} aria-hidden="true" /></IconButton>
            <SaveButton type="button" state={adding ? "busy" : save.state} busyLabel="Adicionando…" disabled={adding || !newLabel.trim()} onClick={() => void addConnection()}>Adicionar conexão</SaveButton>
            <SaveToast show={save.done}>Conexão adicionada</SaveToast>
          </div>
          {actionError ? <p className="error md:col-span-2" role="alert">{actionError}</p> : null}
        </section>
      ) : null}

      {confirmingReconnect && canManageConnection && reconnectTarget ? (
        <section
          id="connection-reconnect-confirmation"
          className="channels-ai-alert mb-5"
          role="alertdialog"
          aria-labelledby="connection-reconnect-title"
          aria-describedby="connection-reconnect-description"
        >
          <div className="flex items-start gap-3">
            <Warning className="mt-0.5 shrink-0 text-[var(--warning-text)]" size={20} aria-hidden="true" />
            <div>
              <strong id="connection-reconnect-title" className="block text-sm text-[var(--text)]">Confirmar reconexão de “{reconnectTarget.label}”?</strong>
              <p id="connection-reconnect-description" className="mt-1 channels-ai-reading-width text-sm leading-relaxed text-[var(--warning-text)]">
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
        <section className="channels-ai-alert mb-5" role="alertdialog" aria-labelledby="connection-action-title" aria-describedby="connection-action-description">
          <div className="flex items-start gap-3">
            <Warning className="mt-0.5 shrink-0 text-[var(--warning-text)]" size={20} aria-hidden="true" />
            <div>
              <strong id="connection-action-title" className="block text-sm text-[var(--text)]">
                {confirmedAction.kind === "promote" ? `Tornar “${confirmedAction.connection.label}” principal?` : `Remover “${confirmedAction.connection.label}”?`}
              </strong>
              <p id="connection-action-description" className="mt-1 channels-ai-reading-width text-sm leading-relaxed text-[var(--warning-text)]">
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
        <section className="mb-5 flex flex-wrap items-center justify-between gap-4 border-y border-[var(--warning-border)] bg-[var(--warning-subtle)] px-4 py-4" role="status" aria-live="polite">
          <div className="flex channels-ai-min-zero items-start gap-3">
            <Warning className="mt-0.5 shrink-0 text-[var(--warning-text)]" size={19} aria-hidden="true" />
            <div>
              <strong className="block text-sm text-[var(--warning-text)]">Atualização temporariamente indisponível</strong>
              <p className="mt-1 text-sm leading-relaxed text-[var(--warning-text)]">
                Exibindo o último estado válido{lastUpdatedAt ? `, atualizado às ${lastUpdatedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}.
                {retryDelayMs ? ` Nova tentativa automática em aproximadamente ${retryDelaySeconds}s.` : ""}
              </p>
              <p className="mono mt-1 type-caption text-[var(--warning-text)]">{pollingError}</p>
            </div>
          </div>
          <IconButton type="button" label="Tentar agora" disabled={pollingRetrying || reconnecting} onClick={() => retryPollingRef.current()}>
            <ArrowsClockwise size={16} className={pollingRetrying ? "animate-spin" : ""} aria-hidden="true" />
          </IconButton>
        </section>
      ) : null}

      {!loaded && !pollingError ? (
        <div className="channels-ai-grid py-6" aria-busy="true" aria-label="Carregando conexões" role="status">
          <span className="sr-only">Carregando conexões</span>
          <div className="skeleton channels-ai-skeleton--large" />
        </div>
      ) : null}

      {!loaded && pollingError ? (
        <section className="grid justify-items-start gap-3 border-y border-[var(--warning-border)] bg-[var(--warning-subtle)] px-4 py-5 text-[var(--warning-text)]" role="alert">
          <div className="flex items-start gap-3">
            <Warning className="mt-0.5 shrink-0" size={20} aria-hidden="true" />
            <div>
              <strong className="block text-sm">Não foi possível carregar as conexões</strong>
              <p className="mt-1 text-sm text-[var(--warning-text)]">{pollingError}</p>
              {retryDelayMs ? <p className="sub">Nova tentativa automática em aproximadamente {retryDelaySeconds}s.</p> : null}
            </div>
          </div>
          <IconButton type="button" label="Tentar novamente" disabled={pollingRetrying} onClick={() => retryPollingRef.current()}>
            <ArrowsClockwise size={16} className={pollingRetrying ? "animate-spin" : ""} aria-hidden="true" />
          </IconButton>
        </section>
      ) : null}

      {loaded && whatsappConnections.length === 0 ? <Empty>Nenhuma sessão de WhatsApp configurada.</Empty> : null}

      <InstagramConnections
        status={instagramStatus}
        connections={connections}
        canManage={canManageConnection}
        onChanged={async () => { applyConnections(await listConnections()); }}
      />

      {loaded && whatsappConnections.length ? (
        <div className="channels-ai-grid">
          {whatsappConnections.map((item) => {
            const pending = item.status === "qr_pending";
            const busy = actingConnectionId === item.id || (reconnecting && reconnectTarget?.id === item.id);
            return (
              <article key={item.id} role="group" aria-label={`Conexão ${item.label}`} className="channels-ai-connection">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] pb-3">
                  <div className="flex channels-ai-min-zero flex-wrap items-center gap-2">
                    <h2 className="truncate text-lg font-semibold text-[var(--text)]">{item.label}</h2>
                    {item.is_primary ? <span className="mono rounded border border-[var(--primary-border)] bg-[var(--primary-subtle)] px-2 py-0.5 text-[length:var(--text-meta)] leading-[1.45] text-[var(--primary-text)]">Principal</span> : null}
                    <span className={`mono rounded-md border px-2 py-1 type-caption ${item.status === "connected" ? "border-[var(--primary-border)] text-[var(--primary-text)]" : "border-[var(--warning-border)] bg-[var(--warning-subtle)] text-[var(--warning-text)]"}`}>status: {item.status}</span>
                  </div>
                  {canManageConnection ? (
                    <div className="flex flex-wrap gap-2">
                      <IconButton type="button" label="Reconectar" disabled={busy} aria-expanded={confirmingReconnect && reconnectTarget?.id === item.id} aria-controls="connection-reconnect-confirmation" onClick={(event) => openReconnect(item, event.currentTarget)}><ArrowsClockwise size={15} aria-hidden="true" /></IconButton>
                      <PopoverMenu
                        buttonClassName="btn"
                        icon={<DotsThreeVertical size={15} weight="bold" aria-hidden="true" />}
                        ariaLabel={`Mais ações da conexão ${item.label}`}
                        title="Mais ações"
                        align="end"
                        panelClassName="conversation-action-menu__panel"
                      >
                        {(closeMenu) => (
                          <>
                            <button
                              type="button"
                              className="conversation-action-menu__item"
                              disabled={busy}
                              onClick={() => { closeMenu(); setEditingId(item.id); setEditLabel(item.label); setActionError(""); setNotice(""); }}
                            >
                              <PencilSimple size={15} aria-hidden="true" /> Renomear
                            </button>
                            {!item.is_primary ? (
                              <button
                                type="button"
                                className="conversation-action-menu__item"
                                disabled={busy}
                                onClick={(event) => { closeMenu(); requestConfirmedAction({ kind: "promote", connection: item }, event.currentTarget); }}
                              >
                                <Star size={15} aria-hidden="true" /> Tornar principal
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="conversation-action-menu__item conversation-action-menu__item--warn"
                              disabled={busy}
                              onClick={(event) => { closeMenu(); requestConfirmedAction({ kind: "archive", connection: item }, event.currentTarget); }}
                            >
                              <Trash size={15} aria-hidden="true" /> Remover
                            </button>
                          </>
                        )}
                      </PopoverMenu>
                    </div>
                  ) : null}
                </div>

                {editingId === item.id ? (
                  <section className="channels-ai-section channels-ai-form-grid" role="dialog" aria-label={`Renomear conexão ${item.label}`}>
                    <label className="field"><span className="label">Novo rótulo</span><input className="input" maxLength={60} value={editLabel} autoFocus onChange={(event) => setEditLabel(event.target.value)} /></label>
                    <div className="flex flex-wrap gap-2 md:justify-end"><IconButton type="button" label="Cancelar" size="sm" disabled={busy} onClick={() => { setEditingId(null); setActionError(""); }}><X size={15} aria-hidden="true" /></IconButton><SaveButton type="button" state={busy ? "busy" : save.state} busyLabel="Salvando…" disabled={busy || !editLabel.trim()} onClick={() => void saveRename(item)}>Salvar rótulo</SaveButton><SaveToast show={save.done}>Rótulo salvo</SaveToast></div>
                  </section>
                ) : null}

                <div className="channels-ai-connection-layout">
                  <section className="channels-ai-section channels-ai-qr">
                    {pending && item.qr_code ? (
                      <div className="text-center">
                        <div className="channels-ai-qr-code">
                          <QRCodeSVG
                            value={item.qr_code}
                            title={`QR Code de ${item.label}`}
                            size={268}
                            fgColor={qrColors.foreground}
                            bgColor={qrColors.background}
                          />
                        </div>
                        <p className="mt-5 flex items-center justify-center gap-2 text-[var(--text-secondary)]"><i className="dot warn" />Aguardando leitura</p>
                        <p className="mono mt-1 type-caption text-[var(--text-muted)]">QR renovado automaticamente</p>
                      </div>
                    ) : pending ? (
                      <div className="text-center" aria-busy="true" role="status">
                        <ArrowsClockwise size={42} className="mx-auto animate-spin text-[var(--primary)]" aria-hidden="true" />
                        <h3 className="mt-4 text-lg font-semibold">Gerando novo QR Code</h3>
                        <p className="sub">Aguarde a atualização automática da sessão.</p>
                      </div>
                    ) : item.status === "connected" ? (
                      <div className="text-center">
                        <CheckCircle size={52} className="mx-auto text-[var(--primary)]" aria-hidden="true" />
                        <h3 className="mt-4 text-lg font-semibold">WhatsApp conectado</h3>
                        <p className="mono mt-2 text-xs text-[var(--text-secondary)]">{item.phone_number}</p>
                        <p className="sub">Conectado desde {item.last_connected_at ? new Date(item.last_connected_at).toLocaleString("pt-BR") : "data indisponível"}</p>
                      </div>
                    ) : (
                      <div className="text-center">
                        <Warning size={48} className="mx-auto text-[var(--warning-text)]" aria-hidden="true" />
                        <h3 className="mt-4 text-lg font-semibold">Sessão desconectada</h3>
                        <p className="sub">{canManageConnection ? "Use “Reconectar” para gerar um novo QR Code." : "Solicite a uma pessoa com permissão de gerenciamento que gere um novo QR Code."}</p>
                        {item.disconnected_reason ? <p className="mono mt-3 type-caption text-[var(--text-muted)]">Motivo: {item.disconnected_reason}</p> : null}
                      </div>
                    )}
                  </section>
                  <aside className="grid content-start gap-4">
                    <section className="card">
                      <div className="cardtitle">Como conectar</div>
                      <ol className="grid gap-5">
                        {["Abra o WhatsApp no celular e acesse Aparelhos conectados.", "Toque em Conectar um aparelho.", "Aponte a câmera para o QR Code ao lado."].map((text, index) => (
                          <li className="flex gap-3 text-[var(--text-secondary)]" key={text}><b className="channels-ai-step">{index + 1}</b><span>{text}</span></li>
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
                    <section className="card warn flex gap-3 text-sm text-[var(--warning-text)]"><Warning size={20} className="shrink-0 text-[var(--warning-text)]" aria-hidden="true" /><p>Conexão não-oficial: evite disparos em massa e mantenha um padrão de conversa humano.</p></section>
                  </aside>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
    </div></Shell>
  );
}
