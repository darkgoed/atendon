"use client";

import { FormEvent, useMemo, useState } from "react";
import { ArrowsClockwise, Check, Copy, Key, Plus, Trash } from "@phosphor-icons/react";
import useSWR from "swr";
import { Empty } from "@/components/page-state";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { canAccessWithSession, type PanelSession } from "@/lib/session";

type ApiKeyStatus = "active" | "expired" | "revoked" | "inactive";

type ApiKeyItem = {
  id: string;
  name: string;
  keyPrefix: string | null;
  scopes: string[];
  status: ApiKeyStatus;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  rotatedFromId: string | null;
  createdByEmail: string | null;
};

type ScopeOption = { key: string; description: string };
type ApiKeysResponse = { apiKeys: ApiKeyItem[]; availableScopes: ScopeOption[] };
type SecretResult = {
  apiKey: ApiKeyItem;
  secret: string;
  rotation?: { previousKeyId: string; previousKeyRemainsActive: true };
};

const fetcher = <T,>(url: string) => api<T>(url);
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

function formatDate(value: string | null) {
  return value ? dateTime.format(new Date(value)) : "Sem expiração";
}

function statusLabel(status: ApiKeyStatus) {
  return { active: "Ativa", expired: "Expirada", revoked: "Revogada", inactive: "Inativa" }[status];
}

function statusClass(status: ApiKeyStatus) {
  if (status === "active") return "admin-badge admin-badge--ok";
  if (status === "expired") return "admin-badge admin-badge--warn";
  return "admin-badge";
}

export default function WorkspaceApiKeysPage() {
  const { data: session } = useSWR<PanelSession>("/me", fetcher, { revalidateOnFocus: false });
  const canRead = session ? canAccessWithSession(session, ["api_keys.read"]) : false;
  const canManage = session ? canAccessWithSession(session, ["api_keys.manage"]) : false;
  const { data, error: loadError, mutate } = useSWR<ApiKeysResponse>(canRead ? "/workspaces/current/api-keys" : null, fetcher, { revalidateOnFocus: false });
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [secretResult, setSecretResult] = useState<SecretResult | null>(null);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const [previousRevoked, setPreviousRevoked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const scopeDescriptions = useMemo(
    () => new Map((data?.availableScopes ?? []).map((option) => [option.key, option.description])),
    [data?.availableScopes]
  );

  function toggleScope(value: string) {
    setSelectedScopes((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  }

  async function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (secretResult) {
      setMessage("Guarde ou descarte com confirmação o segredo exibido antes de criar outra chave.");
      return;
    }
    setMessage("");
    setCopied(false);
    if (selectedScopes.length === 0) {
      setMessage("Selecione ao menos um scope operacional.");
      return;
    }
    setSaving(true);
    try {
      const result = await api<SecretResult>("/workspaces/current/api-keys", {
        method: "POST",
        body: JSON.stringify({
          name,
          scopes: selectedScopes,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null
        })
      });
      setSecretResult(result);
      setPreviousRevoked(false);
      setName("");
      setExpiresAt("");
      setSelectedScopes([]);
      await mutate();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Falha ao criar chave de API");
    } finally {
      setSaving(false);
    }
  }

  async function rotateKey(key: ApiKeyItem) {
    if (secretResult) {
      setMessage("Guarde ou descarte com confirmação o segredo exibido antes de iniciar outra rotação.");
      return;
    }
    if (!confirm(`Preparar a rotação de “${key.name}”? A chave atual permanecerá ativa até a revogação explícita.`)) return;
    setBusyId(key.id);
    setMessage("");
    setCopied(false);
    try {
      const result = await api<SecretResult>(`/workspaces/current/api-keys/${key.id}/rotate`, {
        method: "POST",
        body: JSON.stringify({})
      });
      setSecretResult(result);
      setPreviousRevoked(false);
      await mutate();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Falha ao rotacionar chave de API");
    } finally {
      setBusyId(null);
    }
  }

  async function revokeKey(key: ApiKeyItem) {
    if (!confirm(`Revogar a chave “${key.name}”? Esta ação interrompe integrações que usam o segredo atual.`)) return;
    setBusyId(key.id);
    setMessage("");
    try {
      await api(`/workspaces/current/api-keys/${key.id}`, { method: "DELETE" });
      await mutate();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Falha ao revogar chave de API");
    } finally {
      setBusyId(null);
    }
  }

  async function copySecret() {
    if (!secretResult) return;
    await navigator.clipboard.writeText(secretResult.secret);
    setCopied(true);
  }

  async function revokePreviousKey() {
    const previousKeyId = secretResult?.rotation?.previousKeyId;
    if (!previousKeyId || previousRevoked) return;
    if (!confirm("Revogar a chave anterior agora? Confirme somente após instalar e validar o novo segredo.")) return;
    setBusyId(previousKeyId);
    setMessage("");
    try {
      await api(`/workspaces/current/api-keys/${previousKeyId}`, { method: "DELETE" });
      setPreviousRevoked(true);
      await mutate();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Falha ao revogar a chave anterior");
    } finally {
      setBusyId(null);
    }
  }

  function discardSecret() {
    const warning = secretResult?.rotation && !previousRevoked
      ? "O segredo deixará de ser exibido e a chave anterior continuará ativa. Você confirma que guardou o novo segredo?"
      : "O segredo não poderá ser exibido novamente. Você confirma que o guardou em local seguro?";
    if (!confirm(warning)) return;
    setSecretResult(null);
    setCopied(false);
    setPreviousRevoked(false);
  }

  return (
    <Shell>
      <header className="pagehead">
        <div>
          <h1>Chaves de API</h1>
          <p>Controle o acesso das integrações por operação. Segredos nunca podem ser consultados novamente.</p>
        </div>
        <span className="admin-badge"><Key size={13} />Workspace</span>
      </header>

      {message ? <p className="error mb-4" role="alert">{message}</p> : null}
      {loadError ? <p className="error mb-4" role="alert">{loadError.message}</p> : null}

      {secretResult ? (
        <section className="card admin-card admin-card--accent mb-4" aria-labelledby="new-api-secret-title">
          <div className="cardtitle">
            <span id="new-api-secret-title">Copie o segredo agora</span>
            <span className="admin-badge admin-badge--warn">Exibição única</span>
          </div>
          <p className="sub mb-4" role="status">
            {secretResult.rotation
              ? <>A nova chave de <strong>{secretResult.apiKey.name}</strong> foi preparada. A chave anterior continua ativa; instale e valide este segredo antes de revogá-la.</>
              : <>Esta é a única exibição do segredo de <strong>{secretResult.apiKey.name}</strong>. Guarde-o em um cofre seguro antes de continuar.</>}
          </p>
          <pre className="admin-code" tabIndex={0}>{secretResult.secret}</pre>
          <div className="admin-actions admin-actions--end">
            <button className="btn" type="button" onClick={copySecret}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? "Copiado" : "Copiar segredo"}
            </button>
            {secretResult.rotation ? (
              <button className="btn" type="button" disabled={previousRevoked || busyId === secretResult.rotation.previousKeyId} onClick={revokePreviousKey}>
                <Trash size={16} />{previousRevoked ? "Anterior revogada" : "Revogar chave anterior"}
              </button>
            ) : null}
            <button className="btn primary" type="button" onClick={discardSecret}>Já guardei</button>
          </div>
          <span className="sr-only" aria-live="polite">{copied ? "Segredo copiado" : ""}</span>
        </section>
      ) : null}

      <section className="admin-grid admin-grid--sidebar">
        <div className="card admin-card">
          <div className="cardtitle">
            <span>Chaves do workspace</span>
            <span className="sub">{data?.apiKeys.length ?? 0} total</span>
          </div>
          {!session || (canRead && !data && !loadError) ? (
            <div className="grid gap-2" aria-label="Carregando chaves">
              {[1, 2, 3].map((item) => <div className="skeleton h-16" key={item} />)}
            </div>
          ) : !canRead ? (
            <Empty>Você não tem permissão para visualizar chaves de API.</Empty>
          ) : data?.apiKeys.length === 0 ? (
            <Empty>Nenhuma chave criada. Defina somente os scopes necessários para a primeira integração.</Empty>
          ) : (
            <div className="admin-table-wrap responsive-table-wrap">
              <table className="admin-table responsive-table">
                <thead><tr><th>Chave</th><th>Scopes</th><th>Uso e validade</th><th>Status</th><th>Ações</th></tr></thead>
                <tbody>
                  {data?.apiKeys.map((key) => (
                    <tr key={key.id}>
                      <td data-label="Chave">
                        <strong>{key.name}</strong>
                        <span className="sub">{key.keyPrefix ? `${key.keyPrefix}…` : "Chave legada"}</span>
                      </td>
                      <td data-label="Scopes">
                        <strong>{key.scopes.length} operação(ões)</strong>
                        <span className="sub">{key.scopes.map((item) => scopeDescriptions.get(item) ?? item).join(" · ")}</span>
                      </td>
                      <td data-label="Uso e validade">
                        <strong>{key.lastUsedAt ? `Usada em ${formatDate(key.lastUsedAt)}` : "Nunca utilizada"}</strong>
                        <span className="sub">Expira: {formatDate(key.expiresAt)}</span>
                      </td>
                      <td data-label="Status"><span className={statusClass(key.status)}>{statusLabel(key.status)}</span></td>
                      <td data-label="Ações">
                        {canManage && (key.status === "active" || key.status === "expired") ? (
                          <div className="admin-actions">
                            {key.status === "active" ? <button className="iconbtn" type="button" disabled={busyId === key.id || Boolean(secretResult)} aria-label={`Rotacionar ${key.name}`} onClick={() => rotateKey(key)}><ArrowsClockwise size={16} /></button> : null}
                            <button className="iconbtn danger" type="button" disabled={busyId === key.id} aria-label={`Revogar ${key.name}`} onClick={() => revokeKey(key)}><Trash size={16} /></button>
                          </div>
                        ) : <span className="sub">Sem ações</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <form className="card admin-card" onSubmit={createKey}>
          <div className="cardtitle"><span>Nova chave</span><Plus size={16} /></div>
          {!canManage ? <p className="sub mb-4" role="status">Acesso somente leitura. A permissão de gestão é necessária para criar chaves.</p> : null}
          <fieldset className="contents" disabled={!canManage || saving || Boolean(secretResult)}>
            <div className="admin-form">
              <label className="field">
                <span className="label">Nome da integração</span>
                <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Agenda do site" minLength={2} maxLength={100} required />
              </label>
              <label className="field">
                <span className="label">Expiração</span>
                <input className="input" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
                <span className="sub">Deixe vazio apenas para integrações sem janela definida.</span>
              </label>
            </div>
            <div className="admin-matrix">
              <section className="admin-matrix-group">
                <header><strong>Scopes operacionais</strong><span>{selectedScopes.length} selecionado(s)</span></header>
                <div className="admin-matrix-rows">
                  {(data?.availableScopes ?? []).map((option) => (
                    <label className="admin-matrix-row" key={option.key}>
                      <div><strong>{option.description}</strong><p>{option.key}</p></div>
                      <input type="checkbox" checked={selectedScopes.includes(option.key)} onChange={() => toggleScope(option.key)} />
                    </label>
                  ))}
                </div>
              </section>
            </div>
            <div className="admin-actions admin-actions--end">
              <button className="btn primary" type="submit" disabled={saving || selectedScopes.length === 0}>
                <Plus size={16} />{saving ? "Criando…" : "Criar chave"}
              </button>
            </div>
          </fieldset>
        </form>
      </section>
    </Shell>
  );
}
