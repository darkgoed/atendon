"use client";

import { useMemo, useState, type FormEvent } from "react";
import useSWR from "swr";
import { Shell } from "@/components/shell";
import { Empty, LoadingCards } from "@/components/page-state";
import { ModalDialog } from "@/components/modal-dialog";
import { api, type ChangelogAiSettings, type RootRelease } from "@/lib/api";
import type { PanelSession } from "@/lib/session";
import { AdminPage, AdminPageHeader, AdminSection } from "@/components/admin";

const fetcher = <T,>(url: string) => api<T>(url);
const classificationLabel: Record<RootRelease["classification"], string> = {
  PATCH: "Patch", DROP: "Drop (minor)", RELEASE: "Release (major)"
};
const aiStatusLabel: Record<RootRelease["aiStatus"], string> = {
  pending: "Pendente", generating: "Gerando…", generated: "Gerado", failed: "Falhou"
};

export default function RootVersionsPage() {
  const { data: session } = useSWR<PanelSession>("/me", fetcher, { revalidateOnFocus: false });
  const root = Boolean(session?.user.isRoot);
  const [tenantFilter, setTenantFilter] = useState("");
  const [detail, setDetail] = useState<RootRelease | null>(null);
  const [editing, setEditing] = useState<RootRelease | null>(null);
  const [message, setMessage] = useState("");
  const { data, error, mutate } = useSWR<{ releases: RootRelease[] }>(
    root ? `/root/versions?limit=200${tenantFilter ? `&tenantSlug=${encodeURIComponent(tenantFilter)}` : ""}` : null,
    fetcher,
    { revalidateOnFocus: false }
  );
  const { data: settingsData, mutate: mutateSettings } = useSWR<{ settings: ChangelogAiSettings }>(
    root ? "/root/settings/changelog-ai" : null,
    fetcher,
    { revalidateOnFocus: false }
  );
  const settings = settingsData?.settings ?? null;
  const releases = useMemo(() => data?.releases ?? [], [data]);

  if (!root) return <Shell><div className="card"><p>Esta área está disponível apenas para usuários ROOT.</p></div></Shell>;

  async function action(release: RootRelease, path: string, body?: unknown) {
    setMessage("");
    try {
      await api(`/root/versions/${release.id}/${path}`, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
      await mutate();
      await setDetail(null);
      setMessage(path === "regenerate" ? "Regeneração disparada; acompanhe o status na lista." : "Ação concluída.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Não foi possível concluir a ação.");
    }
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    const changes = String(form.get("publicChanges") ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    setMessage("");
    try {
      await api(`/root/versions/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          publicTitle: String(form.get("publicTitle") ?? "").trim(),
          publicSummary: String(form.get("publicSummary") ?? "").trim(),
          publicChanges: changes.map((text) => ({ text, tenant_slugs: [] })),
          technicalChangelog: String(form.get("technicalChangelog") ?? "").trim()
        })
      });
      setEditing(null);
      await mutate();
      setMessage("Release editada (override manual registrado).");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Não foi possível salvar a edição.");
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const apiKey = String(form.get("apiKey") ?? "").trim();
    setMessage("");
    try {
      await api("/root/settings/changelog-ai", {
        method: "PUT",
        body: JSON.stringify({
          ...(apiKey ? { apiKey } : {}),
          primaryModel: String(form.get("primaryModel") ?? "").trim(),
          fallbackModel: String(form.get("fallbackModel") ?? "").trim() || null,
          autoGenerateEnabled: form.get("autoGenerateEnabled") === "on",
          autoPublishEnabled: form.get("autoPublishEnabled") === "on"
        })
      });
      await mutateSettings();
      setMessage("Configuração de IA salva. A chave nunca é exibida novamente.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Não foi possível salvar a configuração.");
    }
  }

  return (
    <Shell>
      <AdminPage>
        <AdminPageHeader
          title="Versões e changelogs"
          actions={
            <input
              className="input"
              placeholder="Filtrar por slug da empresa"
              value={tenantFilter}
              onChange={(event) => setTenantFilter(event.target.value)}
            />
          }
        />
        {message ? <p className="accent mb-4" role="status">{message}</p> : null}

        <AdminSection title="Configuração de IA (OpenRouter)" description="Chave criptografada no banco; nunca exposta ao navegador. Usada apenas para gerar o changelog público, fora do caminho crítico do deploy.">
          {settings ? (
            <form className="grid gap-3 sm:grid-cols-2" onSubmit={saveSettings}>
              <label className="field"><span className="label">API key</span>
                <input className="input" name="apiKey" type="password" placeholder={settings.hasApiKey ? `Configurada (${settings.apiKeyHint})` : "sk-or-v1-…"} />
              </label>
              <label className="field"><span className="label">Modelo principal</span>
                <input className="input" name="primaryModel" defaultValue={settings.primaryModel} required />
              </label>
              <label className="field"><span className="label">Modelo de fallback (opcional)</span>
                <input className="input" name="fallbackModel" defaultValue={settings.fallbackModel ?? ""} />
              </label>
              <div className="field">
                <label className="flex items-center gap-2"><input type="checkbox" name="autoGenerateEnabled" defaultChecked={settings.autoGenerateEnabled} /> Gerar changelog com IA automaticamente</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="autoPublishEnabled" defaultChecked={settings.autoPublishEnabled} /> Publicar automaticamente ao gerar</label>
              </div>
              <div className="sm:col-span-2"><button type="submit" className="btn primary">Salvar configuração</button></div>
            </form>
          ) : <LoadingCards label="Carregando configuração" />}
        </AdminSection>

        <AdminSection className="mt-4" title="Releases" description={`${releases.length} registro(s)`}>
          {error ? <p className="error" role="alert">Não foi possível carregar as releases.</p> : null}
          {!data && !error ? <LoadingCards label="Carregando releases" /> : null}
          {data && releases.length === 0 ? <Empty>Nenhuma release registrada.</Empty> : null}
          {releases.length > 0 ? (
            <div className="admin-table-wrap responsive-table-wrap">
              <table className="admin-table responsive-table">
                <thead><tr><th>Build</th><th>Versão</th><th>Tipo</th><th>Commit</th><th>Escopo</th><th>IA</th><th>Publicada</th><th></th></tr></thead>
                <tbody>
                  {releases.map((release) => (
                    <tr key={release.id}>
                      <td className="mono">#{release.buildNumber}</td>
                      <td className="mono">v{release.version}{release.manualOverride ? " ✎" : ""}</td>
                      <td>{classificationLabel[release.classification]}</td>
                      <td className="mono">{release.commitSha.slice(0, 12)}</td>
                      <td>{release.scope === "GLOBAL" ? "Global" : release.tenantSlugsDetected.join(", ") || "Tenant"}</td>
                      <td><span className={release.aiStatus === "failed" ? "error" : "sub"}>{aiStatusLabel[release.aiStatus]}</span>{release.aiStatus === "generated" && release.aiModelUsed ? <span className="sub"> · {release.aiModelUsed}</span> : null}</td>
                      <td>{release.published ? "Sim" : "Não"}</td>
                      <td><button type="button" className="btn" onClick={() => setDetail(release)}>Detalhes</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </AdminSection>
      </AdminPage>

      {detail ? (
        <ModalDialog labelledBy="release-detail-title" onClose={() => setDetail(null)} className="max-w-2xl">
          <div className="card admin-card">
            <h2 id="release-detail-title">AtendON v{detail.version} · Build #{detail.buildNumber}</h2>
            <p className="sub">{classificationLabel[detail.classification]} — {detail.classificationReason}</p>
            <dl className="mt-3 space-y-1 text-sm">
              <div><dt className="sub inline">Commit: </dt><span className="mono">{detail.commitSha}</span> <span className="sub">({detail.branch})</span></div>
              <div><dt className="sub inline">Diff: </dt><span className="mono">+{detail.additions}/-{detail.deletions}</span> <span className="sub">em {detail.filesChanged.length} arquivo(s)</span></div>
              {detail.modulesAffected.length > 0 ? <div><dt className="sub inline">Módulos: </dt><span>{detail.modulesAffected.join(", ")}</span></div> : null}
              <div><dt className="sub inline">Escopo: </dt><span>{detail.scope === "GLOBAL" ? "GLOBAL" : `TENANT (${detail.tenantSlugsDetected.join(", ")})`}</span></div>
              {detail.aiError ? <div><dt className="sub inline">Erro da IA: </dt><span className="error">{detail.aiError}</span></div> : null}
            </dl>
            <h3 className="mt-3">Changelog técnico</h3>
            <pre className="max-h-40 overflow-auto text-xs">{detail.technicalChangelog}</pre>
            <h3 className="mt-3">Changelog público</h3>
            {detail.publicTitle ? <p><strong>{detail.publicTitle}</strong> — {detail.publicSummary}</p> : <p className="sub">Ainda não gerado.</p>}
            <ul className="list-disc list-inside text-sm">
              {detail.publicChanges.map((change, index) => <li key={index}>{change.text}{change.tenant_slugs.length > 0 ? <span className="sub"> ({change.tenant_slugs.join(", ")})</span> : null}</li>)}
            </ul>
            <div className="admin-actions mt-4 flex-wrap">
              <button type="button" className="btn" onClick={() => setEditing(detail)}>Editar</button>
              <button type="button" className="btn" onClick={() => void action(detail, "regenerate")}>Regenerar com IA</button>
              {detail.published
                ? <button type="button" className="btn warn" onClick={() => void action(detail, "unpublish")}>Despublicar</button>
                : <button type="button" className="btn primary" onClick={() => void action(detail, "publish")}>Publicar</button>}
            </div>
          </div>
        </ModalDialog>
      ) : null}

      {editing ? (
        <ModalDialog labelledBy="release-edit-title" onClose={() => setEditing(null)} className="max-w-2xl">
          <form className="card admin-card" onSubmit={saveEdit}>
            <h2 id="release-edit-title">Editar release v{editing.version}</h2>
            <label className="field"><span className="label">Título público</span><input className="input" name="publicTitle" defaultValue={editing.publicTitle ?? ""} required /></label>
            <label className="field"><span className="label">Resumo público</span><input className="input" name="publicSummary" defaultValue={editing.publicSummary ?? ""} required /></label>
            <label className="field"><span className="label">Itens públicos (um por linha)</span>
              <textarea className="input" name="publicChanges" rows={6} defaultValue={editing.publicChanges.map((change) => change.text).join("\n")} required />
            </label>
            <label className="field"><span className="label">Changelog técnico</span><textarea className="input" name="technicalChangelog" rows={4} defaultValue={editing.technicalChangelog} /></label>
            <div className="admin-actions"><button type="submit" className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setEditing(null)}>Cancelar</button></div>
          </form>
        </ModalDialog>
      ) : null}
    </Shell>
  );
}
