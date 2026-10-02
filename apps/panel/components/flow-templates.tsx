"use client";

/**
 * Templates de fluxo (C1-f da spec v7) — snapshot nomeado por tenant.
 * Endpoints existentes: GET/POST/PUT/DELETE /qualification/flow-templates.
 * Dois usos: "Novo a partir de template" (lista de fluxos → cria fluxo com a
 * definition do template) e "Salvar como template" (lista → grava a definition
 * salva do fluxo). A validação da definition é do backend (flowDefinitionSchema).
 */

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Trash } from "@/components/icons";
import { Empty } from "@/components/page-state";
import { Button, Dialog, Field, Input, SaveButton } from "@/components/ui";
import { api } from "@/lib/api";
import { formatPanelDateTime } from "@/lib/format";

export type FlowTemplateRow = {
  id: string;
  nome: string;
  descricao: string | null;
  criado_em: string;
  atualizado_em: string;
};

type TemplateDetail = FlowTemplateRow & { definition: unknown };

const fetcher = <T,>(url: string) => api<T>(url);

/** Dialog "Novo a partir de template": escolhe template → cria fluxo novo. */
export function NewFlowFromTemplateDialog({
  open,
  onClose,
  onCreate
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, definition: unknown) => void | Promise<unknown>;
}) {
  const { data, error, isLoading, mutate } = useSWR<{ templates: FlowTemplateRow[] }>(
    open ? "/qualification/flow-templates" : null,
    fetcher,
    { revalidateOnFocus: false }
  );
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  useEffect(() => {
    if (!open) return;
    setSelectedId("");
    setName("");
    setCreateError("");
  }, [open]);

  const templates = data?.templates ?? [];
  const selected = templates.find((template) => template.id === selectedId) ?? null;

  async function create() {
    if (!selected || creating) return;
    setCreating(true);
    setCreateError("");
    try {
      const detail = await api<{ template: TemplateDetail }>(`/qualification/flow-templates/${selected.id}`);
      await onCreate(name.trim() || selected.nome, detail.template.definition);
      onClose();
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "Falha ao criar o fluxo a partir do template");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title="Novo fluxo a partir de template"
      description="O template copia a estrutura salva; o fluxo novo nasce inativo e você ajusta tudo no editor."
    >
      {error ? <p className="error mb-2" role="alert">{error instanceof Error ? error.message : "Falha ao carregar templates."}</p> : null}
      {isLoading ? (
        <div className="grid gap-2" role="status" aria-label="Carregando templates">
          {[1, 2, 3].map((row) => <div key={row} className="skeleton h-10" aria-hidden="true" />)}
        </div>
      ) : templates.length === 0 ? (
        <Empty>Nenhum template salvo. Abra um fluxo salvo na lista e use “Salvar como template”.</Empty>
      ) : (
        <div className="grid gap-2">
          <fieldset className="grid gap-1">
            <legend className="sr-only">Templates disponíveis</legend>
            {templates.map((template) => (
              <label
                key={template.id}
                className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${template.id === selectedId ? "border-[var(--primary-border)] bg-[var(--primary-subtle)]" : "border-[var(--border)]"}`}
              >
                <input
                  type="radio"
                  name="flow-template"
                  checked={template.id === selectedId}
                  onChange={() => { setSelectedId(template.id); setName(template.nome); }}
                />
                <span className="min-w-0 flex-1">
                  <strong>{template.nome}</strong>
                  {template.descricao ? <span className="block text-xs text-[var(--text-secondary)]">{template.descricao}</span> : null}
                  <span className="mono block text-xs text-[var(--text-muted)]">salvo em {formatPanelDateTime(template.atualizado_em)}</span>
                </span>
                <FlowTemplateDeleteButton templateId={template.id} templateName={template.nome} onDeleted={() => mutate()} />
              </label>
            ))}
          </fieldset>
          <Field label="Nome do fluxo novo">
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} placeholder="Nome do fluxo" />
          </Field>
          {createError ? <p className="error" role="alert">{createError}</p> : null}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" disabled={creating} onClick={onClose}>Cancelar</Button>
            <SaveButton type="button" state={creating ? "busy" : "idle"} busyLabel="Criando…" disabled={!selected || creating} onClick={() => void create()}>
              Criar fluxo
            </SaveButton>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Dialog "Salvar como template": grava a definition salva do fluxo. */
export function SaveFlowTemplateDialog({
  open,
  flowName,
  definition,
  onClose,
  onSaved
}: {
  open: boolean;
  flowName: string;
  definition: unknown;
  onClose: () => void;
  onSaved: () => unknown | Promise<unknown>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(`${flowName} (template)`);
    setDescription("");
    setError("");
  }, [open, flowName]);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await api("/qualification/flow-templates", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          definition
        })
      });
      await onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao salvar o template");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title="Salvar como template"
      description="O template guarda a estrutura salva deste fluxo (última versão no servidor) para reuso em outros fluxos."
    >
      <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-busy={saving}>
        <Field label="Nome do template">
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} required />
        </Field>
        <Field label="Descrição (opcional)">
          <Input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} placeholder="Ex.: triagem inicial com horário" />
        </Field>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="flex items-center justify-end gap-2">
          <Button type="button" disabled={saving} onClick={onClose}>Cancelar</Button>
          <SaveButton type="submit" state={saving ? "busy" : "idle"} busyLabel="Salvando…">Salvar template</SaveButton>
        </div>
      </form>
    </Dialog>
  );
}

/** Gerenciador leve: excluir templates (usado no dialog de origem). */
export function FlowTemplateDeleteButton({ templateId, templateName, onDeleted }: {
  templateId: string;
  templateName: string;
  onDeleted: () => unknown | Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn quiet"
      disabled={busy}
      aria-label={`Excluir template ${templateName}`}
      onClick={async () => {
        if (!window.confirm(`Excluir o template “${templateName}”?`)) return;
        setBusy(true);
        try {
          await api(`/qualification/flow-templates/${templateId}`, { method: "DELETE" });
          await onDeleted();
        } finally {
          setBusy(false);
        }
      }}
    >
      <Trash size={14} aria-hidden="true" />
    </button>
  );
}
