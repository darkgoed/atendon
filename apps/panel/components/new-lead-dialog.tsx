"use client";

/**
 * Cadastro rápido de contato (dialog) — cria lead via POST /scheduling/leads,
 * o mesmo endpoint da criação por importação/agenda. Telefone obrigatório;
 * nome, origem, campanha, categoria, agenda, parceiro e observação opcionais.
 * Telefone duplicado reativa o contato da lixeira (upsert por telefone).
 * Padrão DS v2: Dialog (Radix) + useSaveFeedback/SaveButton/SaveToast.
 */

import { type FormEvent, useEffect, useState } from "react";
import { Button, Dialog, Field, Input, SaveButton, SaveToast, Select, Textarea, useSaveFeedback } from "@/components/ui";
import { api } from "@/lib/api";
import { formatBrazilianPhone, isValidBrazilianPhone } from "@/lib/phone";

type Option = { id: string; nome: string };
type ConfigOptions = { unidades: Option[]; categorias: Option[]; parceiros: Option[] };

const INITIAL = { nome: "", telefone: "", origem: "", campanha: "", categoria_interesse_id: "", unidade_id: "", parceiro_id: "", observacao: "" };
type Draft = typeof INITIAL;

export function NewLeadDialog({
  open,
  onClose,
  onCreated
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => unknown | Promise<unknown>;
}) {
  const [draft, setDraft] = useState<Draft>(INITIAL);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = useSaveFeedback();

  // Reabrir sempre limpo (cadastro rápido em sequência).
  useEffect(() => {
    if (!open) return;
    setDraft(INITIAL);
    setError("");
  }, [open]);

  // Catálogo da agenda (categorias/unidades/parceiros) — os mesmos endpoints
  // dos filtros da listagem; falha silenciosa: os três são opcionais.
  const [options, setOptions] = useState<ConfigOptions | null>(null);
  useEffect(() => {
    if (!open || options) return;
    let cancelled = false;
    Promise.all([
      api<{ unidades: Option[] }>("/scheduling/config/unidades"),
      api<{ categorias: Option[] }>("/scheduling/config/categorias"),
      api<{ parceiros: Option[] }>("/scheduling/config/parceiros")
    ]).then(([units, categories, partners]) => {
      if (cancelled) return;
      setOptions({ unidades: units.unidades, categorias: categories.categorias, parceiros: partners.parceiros });
    }).catch(() => {
      if (!cancelled) setOptions({ unidades: [], categorias: [], parceiros: [] });
    });
    return () => { cancelled = true; };
  }, [open, options]);

  const set = (key: keyof Draft, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const phoneValid = isValidBrazilianPhone(draft.telefone) || draft.telefone.trim().startsWith("+");
  const canSubmit = draft.telefone.trim() !== "" && phoneValid && !saving;
  const hasOptions = Boolean(options && (options.unidades.length || options.categorias.length || options.parceiros.length));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError("");
    try {
      await api("/scheduling/leads", {
        method: "POST",
        body: JSON.stringify({
          telefone: draft.telefone.trim(),
          ...(draft.nome.trim() ? { nome: draft.nome.trim() } : {}),
          ...(draft.origem.trim() ? { origem: draft.origem.trim() } : {}),
          ...(draft.campanha.trim() ? { campanha: draft.campanha.trim() } : {}),
          ...(draft.categoria_interesse_id ? { categoria_interesse_id: draft.categoria_interesse_id } : {}),
          ...(draft.unidade_id ? { unidade_id: draft.unidade_id } : {}),
          ...(draft.parceiro_id ? { parceiro_id: draft.parceiro_id } : {})
        })
      });
      await onCreated();
      save.markDone();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível criar o contato");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title="Novo contato"
      description="O telefone é a identidade do contato no WhatsApp; os demais campos são opcionais."
    >
      <form className="grid gap-3" onSubmit={submit}>
        <Field label="Nome">
          <Input value={draft.nome} onChange={(event) => set("nome", event.target.value)} maxLength={200} placeholder="Ex.: Maria Silva" />
        </Field>
        <Field
          label="Telefone / WhatsApp"
          hint="Brasil: DDD + número. Outros países: +código do país."
          error={!draft.telefone.trim() || phoneValid ? undefined : "Informe DDD + número (10 ou 11 dígitos) ou comece com + para internacional."}
        >
          <Input
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            value={draft.telefone}
            maxLength={20}
            placeholder="11 91234-5678"
            onChange={(event) => set("telefone", formatBrazilianPhone(event.target.value))}
            required
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Origem (opcional)">
            <Input value={draft.origem} onChange={(event) => set("origem", event.target.value)} maxLength={200} placeholder="Ex.: Indicação" />
          </Field>
          <Field label="Campanha (opcional)">
            <Input value={draft.campanha} onChange={(event) => set("campanha", event.target.value)} maxLength={200} placeholder="Ex.: Meta · Lançamento agosto" />
          </Field>
        </div>
        {hasOptions ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {options?.categorias.length ? (
              <Field label="Categoria (opcional)">
                <Select value={draft.categoria_interesse_id} onChange={(event) => set("categoria_interesse_id", event.target.value)}>
                  <option value="">Sem categoria</option>
                  {options.categorias.map((option) => <option key={option.id} value={option.id}>{option.nome}</option>)}
                </Select>
              </Field>
            ) : null}
            {options?.unidades.length ? (
              <Field label="Agenda (opcional)">
                <Select value={draft.unidade_id} onChange={(event) => set("unidade_id", event.target.value)}>
                  <option value="">Sem agenda</option>
                  {options.unidades.map((option) => <option key={option.id} value={option.id}>{option.nome}</option>)}
                </Select>
              </Field>
            ) : null}
            {options?.parceiros.length ? (
              <Field label="Parceiro (opcional)">
                <Select value={draft.parceiro_id} onChange={(event) => set("parceiro_id", event.target.value)}>
                  <option value="">Sem parceiro</option>
                  {options.parceiros.map((option) => <option key={option.id} value={option.id}>{option.nome}</option>)}
                </Select>
              </Field>
            ) : null}
          </div>
        ) : null}
        <Field label="Observação (opcional)" hint="Anotação interna sobre o contato.">
          <Textarea value={draft.observacao} onChange={(event) => set("observacao", event.target.value)} rows={3} maxLength={2000} placeholder="Ex.: prefere contato após as 18h" />
        </Field>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={saving}>Cancelar</Button>
          <SaveButton state={saving ? "busy" : save.state} type="submit" disabled={!canSubmit}>
            Criar contato
          </SaveButton>
        </div>
      </form>
      <SaveToast show={save.done}>Contato criado</SaveToast>
    </Dialog>
  );
}
