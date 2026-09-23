"use client";

import { type FormEvent, useMemo, useState } from "react";
import { Buildings, DotsThreeVertical, DoorOpen, PencilSimple, Plus, WarningCircle, X } from "@phosphor-icons/react";
import useSWR from "swr";
import { Empty } from "@/components/page-state";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { capabilitySourceLabel, type CapabilitiesResponse, type EffectiveCapability } from "@/lib/capabilities";
import { accessStatusLabel } from "@/lib/labels";
import type { CapabilityKey } from "@/lib/panel-manifest";
import { affectedCapabilityKeys, capabilityCascadeImpact, capabilityOverrideValue, parseCapabilityOverride, type CapabilityOverride } from "@/lib/root-capabilities";
import { publishWorkspaceContextChange, type PanelSession } from "@/lib/session";
import { PopoverMenu } from "@/components/popover-menu";
import { AdminField, AdminPage, AdminPageHeader, AdminSection, AdminTableScroll } from "@/components/admin";
import { IconButton, SaveButton, SaveToast, useSaveFeedback } from "@/components/ui";


type Workspace = {
  id: string; name: string; slug: string; status: "trial" | "active" | "suspended";
  attendant_phone: string | null; created_at: string; updated_at: string;
  member_count: number; pending_invites: number;
};
type CreatedWorkspace = {
  workspace: { id: string; slug: string; sessionId: string };
  ownerInvitation: { id: string; email: string; expiresAt: string };
  token?: string; emailDelivery?: { status: "sent" | "failed"; error?: string };
};
type WorkspaceUpdate = { name?: string; status?: Workspace["status"]; attendantPhone?: string | null };
type CapabilityPatchResponse = CapabilitiesResponse & { changes: unknown[]; operationGroup: string };
type PendingChange = { key: CapabilityKey; override: CapabilityOverride; affected: CapabilityKey[] };

const fetcher = <T,>(url: string) => api<T>(url);
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const capabilityName = (catalog: readonly EffectiveCapability[], key: CapabilityKey) => catalog.find((item) => item.key === key)?.displayName ?? key;

export default function RootWorkspacesPage() {
  const { data: session } = useSWR<PanelSession>("/me", fetcher, { revalidateOnFocus: false, dedupingInterval: 10_000 });
  const { data, error, mutate } = useSWR<{ workspaces: Workspace[] }>(session?.user.isRoot ? "/root/workspaces" : null, fetcher, { revalidateOnFocus: false });
  const [creating, setCreating] = useState(false);
  const [templateTenantId, setTemplateTenantId] = useState("");
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [accessingId, setAccessingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [created, setCreated] = useState<CreatedWorkspace | null>(null);
  const [editing, setEditing] = useState<Workspace | null>(null);
  const [capabilities, setCapabilities] = useState<EffectiveCapability[]>([]);
  const [loadingCapabilities, setLoadingCapabilities] = useState(false);
  const [capabilitiesError, setCapabilitiesError] = useState("");
  const [savingCapability, setSavingCapability] = useState<CapabilityKey | null>(null);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const createSave = useSaveFeedback();
  const editSave = useSaveFeedback();
  const workspaces = data?.workspaces ?? [];

  const previewKey = templateTenantId ? `/root/workspaces/${templateTenantId}/capabilities` : null;
  const { data: preview, error: previewError, isLoading: previewLoading, mutate: retryPreview } = useSWR<CapabilitiesResponse>(previewKey, fetcher, {
    revalidateOnFocus: false, keepPreviousData: false, shouldRetryOnError: false
  });
  const sortedCapabilities = useMemo(() => [...capabilities].sort((a, b) => a.uiOrder - b.uiOrder || a.displayName.localeCompare(b.displayName, "pt-BR")), [capabilities]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!templateTenantId) return setMessage("Selecione uma empresa modelo antes de criar o workspace.");
    const form = event.currentTarget;
    const formData = new FormData(form);
    setCreating(true); setMessage(""); setNotice(""); setCreated(null);
    try {
      const response = await api<CreatedWorkspace>("/root/workspaces", {
        method: "POST",
        body: JSON.stringify({
          name: String(formData.get("name") ?? ""),
          slug: String(formData.get("slug") ?? "").trim() || undefined,
          ownerEmail: String(formData.get("ownerEmail") ?? ""),
          capabilityTemplateTenantId: templateTenantId
        })
      });
      setCreated(response); form.reset(); setTemplateTenantId(""); await mutate(); createSave.markDone();
    } catch (submitError) { setMessage(submitError instanceof Error ? submitError.message : "Falha ao criar workspace"); }
    finally { setCreating(false); }
  }

  async function updateWorkspace(id: string, payload: WorkspaceUpdate): Promise<boolean> {
    setUpdatingId(id); setMessage(""); setNotice("");
    try {
      const response = await api<{ workspace: Workspace }>(`/root/workspaces/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
      await mutate((current) => current ? { workspaces: current.workspaces.map((item) => item.id === id ? { ...item, ...response.workspace } : item) } : current, false);
      setEditing((current) => current?.id === id ? { ...current, ...response.workspace } : current);
      setNotice(`Workspace ${response.workspace.name} atualizado.`); return true;
    } catch (updateError) { setMessage(updateError instanceof Error ? updateError.message : "Falha ao atualizar workspace"); return false; }
    finally { setUpdatingId(null); }
  }

  async function openEditor(workspace: Workspace) {
    setEditing(workspace); setCapabilities([]); setPending(null); setLoadingCapabilities(true); setCapabilitiesError(""); setMessage("");
    try {
      const response = await api<CapabilitiesResponse>(`/root/workspaces/${workspace.id}/capabilities`);
      setCapabilities(response.capabilities);
    } catch (loadError) { setCapabilitiesError(loadError instanceof Error ? loadError.message : "Falha ao carregar o catálogo de módulos"); }
    finally { setLoadingCapabilities(false); }
  }

  async function applyCapability(change: PendingChange, confirmCascade: boolean) {
    if (!editing || savingCapability) return;
    setSavingCapability(change.key); setMessage(""); setNotice("");
    try {
      const response = await api<CapabilityPatchResponse>(`/root/workspaces/${editing.id}/capabilities`, {
        method: "PATCH",
        body: JSON.stringify({ changes: [{ key: change.key, override: change.override }], confirmCascade })
      });
      setCapabilities(response.capabilities); setPending(null); setNotice(`Módulos de ${editing.name} atualizados.`);
    } catch (updateError) {
      if (updateError instanceof ApiError && updateError.status === 409) {
        const affected = affectedCapabilityKeys(updateError.body);
        const body = updateError.body && typeof updateError.body === "object" ? updateError.body as { code?: unknown } : {};
        if (body.code === "CAPABILITY_CASCADE_CONFIRMATION_REQUIRED" && affected.length) {
          setPending({ ...change, affected });
          return;
        }
      }
      setMessage(updateError instanceof Error ? updateError.message : "Falha ao atualizar o módulo");
    } finally { setSavingCapability(null); }
  }

  function requestCapabilityChange(capability: EffectiveCapability, value: string) {
    const override = parseCapabilityOverride(value);
    const change = { key: capability.key, override, affected: capabilityCascadeImpact(capabilities, capability.key, override) };
    if (change.affected.length) setPending(change); else void applyCapability(change, false);
  }

  async function accessWorkspace(workspace: Workspace) {
    setAccessingId(workspace.id); setMessage(""); setNotice("");
    try {
      await api<PanelSession>(`/root/workspaces/${workspace.id}/access`, { method: "POST" });
      try { publishWorkspaceContextChange(localStorage, workspace.id); } catch { /* sem sincronização entre abas */ }
      window.location.href = "/";
    }
    catch (accessError) { setMessage(accessError instanceof Error ? accessError.message : "Falha ao acessar workspace"); setAccessingId(null); }
  }

  async function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const formData = new FormData(event.currentTarget);
    const attendantPhone = String(formData.get("attendantPhone") ?? "").trim();
    const ok = await updateWorkspace(editing.id, { name: String(formData.get("name") ?? "").trim(), status: String(formData.get("status") ?? editing.status) as Workspace["status"], attendantPhone: attendantPhone || null });
    if (ok) editSave.markDone();
  }

  return <Shell>
    <AdminPage>
    <AdminPageHeader title="Workspaces" />
    {message ? <p className="error mb-4" role="alert">{message}</p> : null}
    {notice ? <p className="accent mb-4 text-sm" role="status">{notice}</p> : null}
    <SaveToast show={createSave.done}>Workspace criado</SaveToast>
    <SaveToast show={editSave.done}>Workspace atualizado</SaveToast>
    {error ? <section className="mb-4 flex flex-wrap items-center justify-between gap-3 border-y border-[var(--warning-border)] bg-[var(--warning-subtle)] px-4 py-4" role="alert"><p className="error">{error.message}</p><button type="button" className="btn warn" onClick={() => void mutate()}>Tentar novamente</button></section> : null}

    <section className={created || editing ? "admin-grid admin-grid--sidebar" : "admin-stack max-w-md"}>
      <form className="card admin-card" aria-busy={creating} onSubmit={submit}>
        <div className="cardtitle"><span>Criar workspace</span><span className="sub">owner inicial por convite</span></div>
        <div className="admin-form">
          <AdminField label="Nome" htmlFor="workspace-name"><input id="workspace-name" className="input" name="name" placeholder="Operação Sul" disabled={creating} required /></AdminField>
          <label className="field"><span className="label">Slug opcional</span><input className="input mono" name="slug" placeholder="operacao-sul" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" disabled={creating} /></label>
          <label className="field"><span className="label">E-mail do owner</span><input className="input" name="ownerEmail" type="email" placeholder="owner@empresa.com" disabled={creating} required /></label>
          <label className="field"><span className="label">Empresa modelo</span><select className="input" value={templateTenantId} onChange={(event) => setTemplateTenantId(event.target.value)} disabled={creating} required><option value="">Selecione o modelo</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select><small className="sub">Somente os valores efetivos dos módulos serão copiados.</small></label>
          {templateTenantId ? <div className="border-y border-[var(--border)] py-3" aria-live="polite">
            <span className="label">Prévia de {workspaces.find((workspace) => workspace.id === templateTenantId)?.name}</span>
            {previewLoading ? <div className="mt-2 grid gap-2" aria-busy="true"><span className="skeleton h-7" /><span className="skeleton h-7" /></div>
              : previewError ? <div className="mt-2 flex items-center justify-between gap-2 text-xs text-[var(--warning-text)]" role="alert"><span>Não foi possível carregar a prévia.</span><button type="button" className="btn warn" onClick={() => void retryPreview()}>Tentar novamente</button></div>
                : <ul className="mt-2 grid gap-1.5">{(preview?.capabilities ?? []).filter((item) => item.tenantConfigurable).sort((a, b) => a.uiOrder - b.uiOrder).map((item) => <li key={item.key} className="flex items-center justify-between gap-3 text-xs"><span>{item.displayName}</span><span className={`admin-badge${item.enabled ? " admin-badge--ok" : ""}`}>{!item.supported ? "Não provisionada" : item.enabled ? "Ativo" : "Desativado"}</span></li>)}</ul>}
          </div> : null}
          <SaveButton state={creating ? "busy" : createSave.state} type="submit" icon={<Plus size={16} aria-hidden="true" />} busyLabel="Criando…" doneLabel="Criado" disabled={!templateTenantId || previewLoading || Boolean(previewError)}>Criar workspace</SaveButton>
        </div>
      </form>

      {created ? <div className="card admin-card admin-card--accent" role="status"><div className="cardtitle"><span>Provisionado</span><Buildings size={16} className="accent" aria-hidden="true" /></div><dl className="admin-meta-list"><div><dt>Slug</dt><dd>{created.workspace.slug}</dd></div><div><dt>Owner</dt><dd>{created.ownerInvitation.email}</dd></div><div><dt>Expira em</dt><dd>{dateTime.format(new Date(created.ownerInvitation.expiresAt))}</dd></div>{created.emailDelivery?.status === "failed" ? <div><dt>E-mail</dt><dd className="warning">{created.emailDelivery.error ?? "Falha ao enviar convite por e-mail."}</dd></div> : null}{created.token ? <div><dt>Link público</dt><dd><a className="admin-inline-link" href={`/convite?token=${created.token}`}>/convite?token={created.token}</a></dd></div> : null}</dl></div> : null}

      {editing ? <form className="card admin-card" aria-busy={updatingId === editing.id} onSubmit={submitEdit}>
        <div className="cardtitle"><span>Editar workspace</span><span className="sub mono">{editing.slug}</span></div>
        <div className="admin-form">
          <label className="field"><span className="label">Nome</span><input className="input" name="name" defaultValue={editing.name} disabled={updatingId === editing.id} required /></label>
          <label className="field"><span className="label">Status</span><select className="input" name="status" defaultValue={editing.status} disabled={updatingId === editing.id}><option value="trial">Trial</option><option value="active">Ativo</option><option value="suspended">Suspenso</option></select></label>
          <label className="field"><span className="label">Telefone de atendimento</span><input className="input" name="attendantPhone" defaultValue={editing.attendant_phone ?? ""} placeholder="5511999999999" disabled={updatingId === editing.id} /></label>
          <section className="border-t border-[var(--border)] pt-5" aria-labelledby="workspace-capabilities-title">
            <div className="mb-3"><span className="label">Catálogo comercial</span><h2 id="workspace-capabilities-title" className="mt-1 text-base">Módulos da empresa</h2><p className="sub mt-1">Herdar remove o override. Dependências são aplicadas na mesma operação.</p></div>
            {loadingCapabilities ? <div className="grid gap-2" aria-busy="true">{[1, 2, 3].map((item) => <span key={item} className="skeleton h-16" />)}</div>
              : capabilitiesError ? <div className="flex items-center justify-between gap-2 border-y border-[var(--warning-border)] py-3 text-xs text-[var(--warning-text)]" role="alert"><span>{capabilitiesError}</span><button type="button" className="btn warn" onClick={() => void openEditor(editing)}>Tentar novamente</button></div>
                : <div className="divide-y divide-[var(--border)] border-y border-[var(--border)]">{sortedCapabilities.map((capability) => <div key={capability.key} className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_170px] sm:items-center">
                  <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{capability.displayName}</strong><span className={`admin-badge${capability.enabled ? " admin-badge--ok" : ""}`}>{!capability.supported ? "Não provisionada" : capability.enabled ? "Ativo" : "Desativado"}</span><span className="admin-badge">{capabilitySourceLabel[capability.source] ?? capability.source}</span></div><p className="sub mt-1">{capability.description}</p>{capability.blockedBy.length ? <p className="mt-1 text-xs text-[var(--warning-text)]">Bloqueado por {capability.blockedBy.map((key) => capabilityName(capabilities, key)).join(", ")}.</p> : null}{capability.dependencies.length ? <p className="mono mt-1 type-caption text-[var(--text-muted)]">Depende de {capability.dependencies.map((key) => capabilityName(capabilities, key)).join(", ")}</p> : null}</div>
                  <label className="field"><span className="sr-only">Estado de {capability.displayName}</span><select className="input" value={capabilityOverrideValue(capability)} disabled={!capability.tenantConfigurable || !capability.supported || savingCapability !== null} onChange={(event) => requestCapabilityChange(capability, event.target.value)}><option value="inherit">Herdar</option><option value="on">Ativar</option><option value="off">Desativar</option></select></label>
                </div>)}</div>}
          </section>
          {pending ? <section className="border-y border-[var(--warning-border)] bg-[var(--warning-subtle)] px-4 py-4" role="alertdialog" aria-labelledby="cascade-confirmation-title"><div className="flex gap-3"><WarningCircle className="shrink-0 text-[var(--warning-text)]" size={20} aria-hidden="true" /><div><strong id="cascade-confirmation-title" className="text-sm">Confirmar alteração em cascata?</strong><p className="sub mt-1">Esta mudança também afeta: {pending.affected.map((key) => capabilityName(capabilities, key)).join(", ")}.</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" className="btn warn active:scale-[.98]" disabled={savingCapability !== null} onClick={() => void applyCapability(pending, true)}>{savingCapability ? "Aplicando…" : "Confirmar mudança"}</button><button type="button" className="btn" disabled={savingCapability !== null} onClick={() => setPending(null)}>Cancelar</button></div></div></div></section> : null}
          <div className="admin-actions"><SaveButton state={updatingId === editing.id ? "busy" : editSave.state} type="submit" busyLabel="Salvando…">Salvar dados</SaveButton><IconButton label="Fechar" onClick={() => setEditing(null)}><X size={16} aria-hidden="true" /></IconButton></div>
        </div>
      </form> : null}
    </section>

    <AdminSection className="card admin-card" title="Catálogo de workspaces" description={`${workspaces.length} registro(s)`}>
      {!data && !error ? <div className="grid gap-2" role="status" aria-busy="true"><span className="sr-only">Carregando workspaces</span>{[1, 2, 3].map((item) => <div key={item} className="skeleton h-12" aria-hidden="true" />)}</div>
        : error ? null : workspaces.length === 0 ? <Empty>Nenhum workspace provisionado.</Empty>
          : <AdminTableScroll className="admin-table-wrap responsive-table-wrap"><table className="admin-table responsive-table"><thead><tr><th>Workspace</th><th>Status</th><th>Membros</th><th>Convites</th><th>Criado em</th><th>Ações</th></tr></thead><tbody>{workspaces.map((workspace) => <tr key={workspace.id}><td data-label="Workspace"><strong>{workspace.name}</strong><span className="sub mono">{workspace.slug}</span></td><td data-label="Status"><span className={`admin-badge${workspace.status === "active" ? " admin-badge--ok" : workspace.status === "suspended" ? " admin-badge--warn" : ""}`}>{accessStatusLabel(workspace.status)}</span></td><td data-label="Membros">{workspace.member_count}</td><td data-label="Convites">{workspace.pending_invites}</td><td data-label="Criado em">{dateTime.format(new Date(workspace.created_at))}</td><td data-label="Ações"><div className="admin-actions"><IconButton label="Editar" size="sm" disabled={updatingId === workspace.id || loadingCapabilities} onClick={() => void openEditor(workspace)}><PencilSimple size={16} aria-hidden="true" /></IconButton><IconButton label="Acessar" size="sm" tone="primary" disabled={workspace.status === "suspended" || accessingId === workspace.id} onClick={() => void accessWorkspace(workspace)}><DoorOpen size={16} aria-hidden="true" /></IconButton><PopoverMenu buttonClassName="btn" icon={<DotsThreeVertical size={16} weight="bold" aria-hidden="true" />} ariaLabel={`Mais ações de ${workspace.name}`} title="Mais ações" panelClassName="conversation-action-menu__panel">{(close) => <button type="button" className={`conversation-action-menu__item${workspace.status === "suspended" ? "" : " conversation-action-menu__item--warn"}`} disabled={updatingId === workspace.id} onClick={() => { close(); if (workspace.status !== "suspended" && !confirm(`Suspender o workspace ${workspace.name}? Os acessos serão interrompidos.`)) return; void updateWorkspace(workspace.id, { status: workspace.status === "suspended" ? "active" : "suspended" }); }}>{workspace.status === "suspended" ? "Reativar workspace" : "Suspender workspace"}</button>}</PopoverMenu></div></td></tr>)}</tbody></table></AdminTableScroll>}
    </AdminSection>
    </AdminPage>
  </Shell>;
}
