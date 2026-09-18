"use client";

/**
 * Campos personalizados por empresa (R7 v6): CRUD do catálogo em
 * /organization/custom-fields. Tipos text/number/currency/date/select/
 * multiselect/boolean; options apenas para select/multiselect; required.
 * Observação: o backend só aceita PATCH de label/options/required — tipo e
 * key são fixados na criação, então o dialog trava o tipo na edição.
 */

import { Plus, Trash } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useState } from "react";
import useSWR from "swr";
import { Shell } from "@/components/shell";
import { Badge, Button, Dialog, EmptyState, Field, Input, Select, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { usePermission } from "@/lib/use-permission";
import styles from "./campos.module.css";

type FieldType = "text" | "number" | "currency" | "date" | "select" | "multiselect" | "boolean";

type CustomField = {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  options: string[] | null;
  required: boolean;
  created_at: string;
};

type FieldsResponse = { fields: CustomField[] } | CustomField[];

const fetcher = <T,>(url: string) => api<T>(url);

const TYPE_LABELS: Record<FieldType, string> = {
  text: "Texto",
  number: "Número",
  currency: "Moeda",
  date: "Data",
  select: "Seleção",
  multiselect: "Seleção múltipla",
  boolean: "Sim/Não"
};

const FIELD_TYPES: FieldType[] = ["text", "number", "currency", "date", "select", "multiselect", "boolean"];

function normalizeFields(payload: FieldsResponse | undefined): CustomField[] {
  if (!payload) return [];
  return Array.isArray(payload) ? payload : payload.fields;
}

function FieldDialog({
  open,
  field,
  onClose,
  onSaved
}: {
  open: boolean;
  field: CustomField | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [optionsText, setOptionsText] = useState("");
  const [required, setRequired] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setLabel(field?.label ?? "");
    setType(field?.type ?? "text");
    setOptionsText(field?.options?.join("\n") ?? "");
    setRequired(field?.required ?? false);
    setError("");
  }, [open, field]);

  const needsOptions = !field && (type === "select" || type === "multiselect");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = label.trim();
    if (!trimmed || saving) return;
    const options = optionsText.split("\n").map((line) => line.trim()).filter(Boolean);
    if (needsOptions && !options.length) {
      setError("Campos de seleção exigem ao menos uma opção (uma por linha).");
      return;
    }
    setSaving(true);
    setError("");
    try {
      if (field) {
        await api(`/organization/custom-fields/${field.id}`, {
          method: "PATCH",
          body: JSON.stringify({ label: trimmed, options, required })
        });
      } else {
        await api("/organization/custom-fields", {
          method: "POST",
          body: JSON.stringify({ label: trimmed, type, options, required })
        });
      }
      onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao salvar o campo");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={field ? "Editar campo personalizado" : "Novo campo personalizado"}
      description={field ? "O tipo e a chave são fixados na criação; ajuste rótulo, opções e obrigatoriedade." : "O campo fica disponível nos contatos da empresa."}
    >
      <form id="custom-field-dialog-form" className="grid gap-3" onSubmit={submit}>
        <Field label="Rótulo">
          <Input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={200} required placeholder="Ex.: Orçamento aprovado" />
        </Field>
        <Field label="Tipo" hint={field ? "Tipo fixado na criação." : "Define como o valor é preenchido e validado nos contatos."}>
          <Select value={type} onChange={(event) => setType(event.target.value as FieldType)} disabled={Boolean(field)}>
            {FIELD_TYPES.map((value) => <option key={value} value={value}>{TYPE_LABELS[value]}</option>)}
          </Select>
        </Field>
        {needsOptions || (field && (field.type === "select" || field.type === "multiselect")) ? (
          <Field label="Opções" hint="Uma opção por linha (máximo 50).">
            <Textarea value={optionsText} onChange={(event) => setOptionsText(event.target.value)} rows={4} placeholder={"Aprovado\nPendente\nRecusado"} />
          </Field>
        ) : null}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} />
          Obrigatório nos contatos
        </label>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button tone="primary" type="submit" disabled={saving || !label.trim()}>
            {saving ? "Salvando…" : field ? "Salvar campo" : "Criar campo"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export default function CustomFieldsPage() {
  const canManage = usePermission("fields.manage");
  const { data, error, isLoading, mutate } = useSWR<FieldsResponse>(canManage ? "/organization/custom-fields" : null, fetcher, {
    revalidateOnFocus: false
  });
  const [dialog, setDialog] = useState<{ open: boolean; field: CustomField | null }>({ open: false, field: null });
  const [listError, setListError] = useState("");
  const fields = normalizeFields(data);

  if (!canManage) return null;

  async function removeField(field: CustomField) {
    if (!window.confirm(`Excluir o campo “${field.label}”? Os valores salvos nos contatos também serão removidos.`)) return;
    setListError("");
    try {
      await api(`/organization/custom-fields/${field.id}`, { method: "DELETE" });
      await mutate();
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : "Falha ao excluir o campo");
    }
  }

  return (
    <Shell>
      <div className={styles.page}>
        <header className="pagehead">
          <div>
            <div className="mono mb-3 flex items-center gap-2 type-caption uppercase tracking-[.16em] text-[var(--primary-text)]">Contatos</div>
            <h1>Campos personalizados</h1>
          </div>
          <div className={styles.toolbar}>
            <span className={styles.toolbarSpacer} />
            <Button tone="primary" onClick={() => setDialog({ open: true, field: null })}>
              <Plus size={15} aria-hidden="true" />Novo campo
            </Button>
          </div>
        </header>

        {error ? <p className="error" role="alert">{error.message}</p> : null}
        {listError ? <p className="error" role="alert">{listError}</p> : null}
        {isLoading && !data ? <div className="skeleton h-24" aria-label="Carregando campos personalizados" /> : null}

        {!isLoading && !fields.length ? (
          <EmptyState
            title="Nenhum campo personalizado"
            action={
              <Button tone="primary" onClick={() => setDialog({ open: true, field: null })}>
                <Plus size={15} aria-hidden="true" />Criar campo
              </Button>
            }
          >
            Crie campos extras (texto, número, moeda, data, seleção ou sim/não) para os contatos da empresa.
          </EmptyState>
        ) : null}

        {fields.length ? (
          <div className={styles.list}>
            {fields.map((field) => (
              <article key={field.id} className={styles.fieldRow} data-field-id={field.id}>
                <div className={styles.fieldRowHeader}>
                  <h3 className={styles.fieldLabel}>{field.label}</h3>
                  <Badge tone="info" variant="pill">{TYPE_LABELS[field.type]}</Badge>
                  {field.required ? <Badge tone="warning" variant="outline">Obrigatório</Badge> : null}
                </div>
                <p className={styles.fieldKey}>chave: {field.key}</p>
                {field.options?.length ? <p className={styles.fieldOptions}>Opções: {field.options.join(", ")}</p> : null}
                <div className={styles.fieldActions}>
                  <Button size="sm" onClick={() => setDialog({ open: true, field })} aria-label={`Editar campo: ${field.label}`}>Editar</Button>
                  <Button size="sm" tone="danger" onClick={() => void removeField(field)} aria-label={`Excluir campo: ${field.label}`}>
                    <Trash size={14} aria-hidden="true" />Excluir
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : null}

        <FieldDialog
          open={dialog.open}
          field={dialog.field}
          onClose={() => setDialog({ open: false, field: null })}
          onSaved={() => void mutate()}
        />
      </div>
    </Shell>
  );
}
