"use client";

import { ArrowClockwise, CheckCircle, InstagramLogo, Link, Trash, Warning } from "@/components/icons";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { disconnectInstagram, refreshInstagram, startInstagramOAuth, type ConnectionState, type InstagramStatus } from "@/lib/connections";
import { instagramDisplayIdentity } from "@/lib/channel-identity";

function safeDate(value?: string | null) {
  if (!value) return "não informado";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "não informado" : date.toLocaleString("pt-BR");
}

export function InstagramConnections({
  status,
  connections,
  canManage,
  onChanged,
  navigateToAuthorization = (url) => window.location.assign(url)
}: {
  status: InstagramStatus | null;
  connections: ConnectionState[];
  canManage: boolean;
  onChanged: () => Promise<void> | void;
  navigateToAuthorization?: (url: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const instagram = connections.filter((item) => item.channel === "instagram");

  async function authorize(connectionId?: string) {
    if (!canManage) return;
    const oauthLabel = label.trim() || connections.find((item) => item.id === connectionId)?.label || "Instagram";
    setBusy(connectionId ?? "new"); setError("");
    try {
      const result = await startInstagramOAuth(oauthLabel, connectionId);
      navigateToAuthorization(result.authorization_url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível iniciar a autorização do Instagram.");
    } finally { setBusy(null); }
  }

  async function action(kind: "refresh" | "disconnect", connection: ConnectionState) {
    if (!canManage || busy) return;
    if (kind === "disconnect" && !window.confirm(`Desconectar a conta ${connection.instagram_username ? instagramDisplayIdentity(connection.instagram_username) : connection.label}? O histórico será preservado.`)) return;
    setBusy(connection.id); setError("");
    try {
      if (kind === "refresh") await refreshInstagram(connection.id);
      else await disconnectInstagram(connection.id);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível atualizar a conexão do Instagram.");
    } finally { setBusy(null); }
  }

  return (
    <section className="channels-ai-section mt-6" aria-labelledby="instagram-connections-title">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="instagram-connections-title" className="flex items-center gap-2 text-lg font-semibold"><InstagramLogo size={20} /> Instagram</h2>
          <p className="sub mt-1">Contas profissionais autorizadas para mensagens diretas.</p>
        </div>
        {status ? <span className="mono type-caption text-[var(--text-secondary)]">Graph {status.graph_version} · limite técnico {status.max_connections}</span> : null}
      </div>
      {status && !status.configured ? (
        <div className="channels-ai-alert" role="status">
          <Warning size={19} className="shrink-0 text-[var(--warning-text)]" aria-hidden="true" />
          <div><strong>Instagram não configurado</strong><p className="mt-1 text-sm">Configuração pendente: {status.missing.length ? status.missing.join(", ") : "nenhuma informação disponível"}.</p></div>
        </div>
      ) : null}
      {status?.configured && !instagram.length ? <p className="sub">Nenhuma conta do Instagram conectada.</p> : null}
      <div className="grid gap-3">
        {instagram.map((connection) => {
          const needsAuth = connection.reconnect_required || connection.status === "reauth_required" || connection.status === "permission_error";
          return <article key={connection.id} className="card" aria-label={`Instagram ${connection.instagram_username ? instagramDisplayIdentity(connection.instagram_username) : connection.label}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0"><h3 className="truncate font-semibold">{connection.label}</h3><p className="mono mt-1 text-sm">{instagramDisplayIdentity(connection.instagram_username)}</p></div>
              <span className={`mono rounded border px-2 py-1 type-caption ${needsAuth ? "border-[var(--warning-border)] text-[var(--warning-text)]" : "border-[var(--primary-border)] text-[var(--primary-text)]"}`}>{needsAuth ? (connection.status === "permission_error" ? "permissão necessária" : "reatorização necessária") : connection.status}</span>
            </div>
            <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2"><div><dt className="label">Token expira em</dt><dd className="mono mt-1">{safeDate(connection.token_expires_at)}</dd></div><div><dt className="label">Conta</dt><dd className="mono mt-1">{connection.instagram_account_id ?? "não informado"}</dd></div></dl>
            {canManage ? <div className="mt-4 flex flex-wrap gap-2">{needsAuth ? <Button type="button" className="btn" disabled={busy === connection.id} onClick={() => void authorize(connection.id)}><ArrowClockwise size={15} />Reautorizar</Button> : <Button type="button" className="btn" disabled={busy === connection.id} onClick={() => void action("refresh", connection)}><ArrowClockwise size={15} />Atualizar</Button>}<Button type="button" className="btn warn" disabled={Boolean(busy)} onClick={() => void action("disconnect", connection)}><Trash size={15} />Desconectar</Button></div> : null}
          </article>;
        })}
      </div>
      {status?.configured && canManage ? <div className="mt-4 flex flex-wrap items-end gap-2"><label className="field min-w-60"><span className="label">Nome da conexão</span><input className="input" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Ex.: Instagram Comercial" /></label><Button type="button" className="btn primary" disabled={!label.trim() || busy === "new"} onClick={() => void authorize()}><Link size={15} />{busy === "new" ? "Abrindo…" : "Conectar Instagram"}</Button></div> : null}
      {error ? <p className="error mt-3" role="alert">{error}</p> : null}
      {status?.configured && !instagram.length ? <p className="mt-3 flex items-center gap-2 text-xs text-[var(--text-secondary)]"><CheckCircle size={15} />A autorização abrirá o fluxo oficial da Meta.</p> : null}
    </section>
  );
}
