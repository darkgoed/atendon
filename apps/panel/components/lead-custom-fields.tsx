"use client";

/**
 * Campos personalizados do contato (R7 v6): leitura via
 * GET /organization/leads/:leadId/custom-values e edição por campo via
 * PUT {field_id, value} — number/currency vão como JSON number, multi como
 * array, date como ISO. Card pronto para o app/contatos/[id]/page.tsx.
 */

import { useState } from "react";
import useSWR from "swr";
import { PencilSimple, X } from "@/components/icons";
import { api } from "@/lib/api";
import { canAccessWithSession, type PanelSession } from "@/lib/session";
import { Field, IconButton, Input, SaveButton, SaveToast, Select, useSaveFeedback } from "@/components/ui";

export type LeadCustomFieldType = "text" | "number" | "currency" | "date" | "select" | "multiselect" | "boolean";

export type LeadCustomField = {
  field_id: string;
  key: string;
  label: string;
  type: LeadCustomFieldType;
  required: boolean;
  options: string[];
  value: unknown;
};

type CustomValuesResponse = { items: LeadCustomField[] };

const fetcher = <T,>(url: string) => api<T>(url);

export function formatCustomFieldValue(field: LeadCustomField): string {
  const value = field.value;
  if (value === null || value === undefined || value === "") return "—";
  switch (field.type) {
    case "currency":
      return Number.isFinite(Number(value))
        ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value))
        : String(value);
    case "number":
      return Number.isFinite(Number(value)) ? new Intl.NumberFormat("pt-BR").format(Number(value)) : String(value);
    case "boolean":
      return value === true ? "Sim" : "Não";
    case "date": {
      const raw = String(value);
      // Data pura (YYYY-MM-DD) formatada por partes: evitar deslocamento de fuso.
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw.slice(8, 10)}/${raw.slice(5, 7)}/${raw.slice(0, 4)}`;
      const parsed = new Date(raw);
      return Number.isNaN(parsed.getTime()) ? raw : parsed.toLocaleDateString("pt-BR");
    }
    case "multiselect":
      return Array.isArray(value) && value.length ? value.join(", ") : "—";
    default:
      return String(value);
  }
}

/** Converte o valor salvo para o formato do input correspondente. */
function draftFromValue(field: LeadCustomField): string {
  const value = field.value;
  if (field.type === "boolean") return value === true ? "true" : value === false ? "false" : "";
  if (field.type === "multiselect") return "";
  if (value === null || value === undefined) return "";
  if (field.type === "date") return String(value).slice(0, 10);
  return String(value);
}

function serializeDraft(field: LeadCustomField, draft: string, multiDraft: string[]): unknown {
  switch (field.type) {
    case "number":
    case "currency": {
      const trimmed = draft.trim();
      if (!trimmed) return null;
      const parsed = Number(trimmed.replace(",", "."));
      return Number.isFinite(parsed) ? parsed : null;
    }
    case "boolean":
      return draft === "" ? null : draft === "true";
    case "multiselect":
      return multiDraft;
    default:
      return draft.trim() === "" ? null : draft.trim();
  }
}

function CustomValueEditor({
  leadId,
  field,
  onSaved,
  onCancel
}: {
  leadId: string;
  field: LeadCustomField;
  onSaved: () => unknown | Promise<unknown>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<string>(draftFromValue(field));
  const [multiDraft, setMultiDraft] = useState<string[]>(Array.isArray(field.value) ? field.value.map(String) : []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const invalidNumber = (field.type === "number" || field.type === "currency") && draft.trim() !== "" && !Number.isFinite(Number(draft.trim().replace(",", ".")));

  async function save() {
    if (saving || invalidNumber) return;
    setSaving(true);
    setError("");
    try {
      await api(`/organization/leads/${encodeURIComponent(leadId)}/custom-values`, {
        method: "PUT",
        body: JSON.stringify({ field_id: field.field_id, value: serializeDraft(field, draft, multiDraft) })
      });
      await onSaved();
      onCancel();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao salvar o valor");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-2">
      <Field label={field.label} hint={field.type === "multiselect" ? "Segure Ctrl/Cmd para selecionar várias opções." : undefined}>
        {field.type === "select" ? (
          <Select value={draft} onChange={(event) => setDraft(event.target.value)} disabled={saving}>
            <option value="">Sem valor</option>
            {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
          </Select>
        ) : field.type === "multiselect" ? (
          <Select multiple value={multiDraft} onChange={(event) => setMultiDraft(Array.from(event.target.selectedOptions, (option) => option.value))} disabled={saving}>
            {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
          </Select>
        ) : field.type === "boolean" ? (
          <Select value={draft} onChange={(event) => setDraft(event.target.value)} disabled={saving}>
            <option value="">Sem valor</option>
            <option value="true">Sim</option>
            <option value="false">Não</option>
          </Select>
        ) : (
          <Input
            type={field.type === "number" || field.type === "currency" ? "number" : field.type === "date" ? "date" : "text"}
            step={field.type === "currency" ? "0.01" : undefined}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={saving}
          />
        )}
      </Field>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="flex gap-2">
        <SaveButton state={saving ? "busy" : "idle"} size="sm" onClick={() => void save()} disabled={saving || invalidNumber}>
          Salvar
        </SaveButton>
        <IconButton size="sm" label="Cancelar" onClick={onCancel} disabled={saving}><X size={14} aria-hidden="true" /></IconButton>
      </div>
    </div>
  );
}

export function LeadCustomFields({ leadId }: { leadId: string }) {
  const { data: session } = useSWR<PanelSession>("/me", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 10_000
  });
  const canManage = Boolean(session && canAccessWithSession(session, ["fields.manage"]));
  const { data, error, mutate } = useSWR<CustomValuesResponse>(
    leadId ? `/organization/leads/${encodeURIComponent(leadId)}/custom-values` : null,
    fetcher,
    { revalidateOnFocus: false }
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const save = useSaveFeedback();
  const items = data?.items ?? [];

  // Sem campos cadastrados o card não ocupa espaço no perfil; com campos,
  // quem gerencia o catálogo edita os valores direto no contato.
  if (!items.length && !canManage) return null;

  return (
    <section className="card" aria-labelledby="lead-custom-fields-title">
      <div id="lead-custom-fields-title" className="cardtitle">Campos personalizados</div>
      {error ? <p className="error" role="alert">{error.message}</p> : null}
      {items.length === 0 ? (
        <p className="sub" role="status">Nenhum campo personalizado configurado para a empresa.</p>
      ) : (
        <dl className="grid gap-3 text-sm">
          {items.map((field) => (
            <div key={field.field_id} className="grid gap-1">
              <dt className="label">
                {field.label}
                {field.required ? <span aria-hidden="true"> *</span> : null}
                <span className="sr-only"> ({field.type})</span>
              </dt>
              {editingId === field.field_id && canManage ? (
                <CustomValueEditor
                  leadId={leadId}
                  field={field}
                  onSaved={() => { void mutate(); save.markDone(); }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <dd className="flex items-center gap-2">
                  <span>{formatCustomFieldValue(field)}</span>
                  {canManage ? (
                    <IconButton size="sm" label={`Editar valor: ${field.label}`} onClick={() => setEditingId(field.field_id)}>
                      <PencilSimple size={14} aria-hidden="true" />
                    </IconButton>
                  ) : null}
                </dd>
              )}
            </div>
          ))}
        </dl>
      )}
      <SaveToast show={save.done}>Valor salvo</SaveToast>
    </section>
  );
}
