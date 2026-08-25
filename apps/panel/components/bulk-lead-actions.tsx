"use client";

import { ArrowCounterClockwise, CheckSquare, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { api } from "@/lib/api";
import { useCaseOrganizationEnabled } from "@/lib/organization";
import { usePermission } from "@/lib/use-permission";
import type { LeadTag } from "@/components/lead-tag-picker";

type BulkAction = "assign" | "tags_add" | "tags_remove" | "move_stage";
type BulkItem = { id: string; expected_updated_at?: string };
type Preview = { valid: boolean; count: number; items: BulkItem[]; errors: Array<{ id: string; code: string; message: string }>; undoable: boolean };
type ApplyResponse = { operation: { id: string; undo_expires_at?: string | null }; result: { action: BulkAction; count: number; undoable: boolean; undo_expires_at?: string | null }; idempotent_replay: boolean };
type Stage = { id: string; name: string; color: string; archived_at?: string | null };
type Attendant = { member_id: string; email: string; selected: boolean; availability_status?: string | null };
const bulkActionLabels: Array<{ value: BulkAction; label: string }> = [
  { value: "tags_add", label: "Adicionar etiqueta" },
  { value: "tags_remove", label: "Remover etiqueta" },
  { value: "move_stage", label: "Mover de etapa" },
  { value: "assign", label: "Atribuir responsável" }
];
const fetcher = <T,>(url: string) => api<T>(url);

export function BulkLeadActions({ selected, onClear, onChanged }: { selected: BulkItem[]; onClear: () => void; onChanged: () => unknown | Promise<unknown> }) {
  const organizationEnabled = useCaseOrganizationEnabled();
  const canApplyTags = usePermission("tags.apply");
  const canMoveStage = usePermission("leads.update_status");
  const canAssign = usePermission("leads.transfer");
  const [action, setAction] = useState<BulkAction>("tags_add");
  const [targetId, setTargetId] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [applyKey, setApplyKey] = useState<string | null>(null);
  const [applied, setApplied] = useState<ApplyResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const { data: tagData } = useSWR<{ tags: LeadTag[] }>(organizationEnabled === true && canApplyTags && selected.length ? "/organization/tags" : null, fetcher, { revalidateOnFocus: false });
  const { data: pipelineData } = useSWR<{ stages: Stage[] }>(organizationEnabled === true && canMoveStage && selected.length ? "/organization/pipeline" : null, fetcher, { revalidateOnFocus: false });
  const { data: attendantData } = useSWR<{ attendants: Attendant[] }>(organizationEnabled === true && canAssign && selected.length ? "/scheduling/config/attendants" : null, fetcher, { revalidateOnFocus: false });
  const availableActions = useMemo(() => bulkActionLabels.filter(({ value }) => (
    value === "assign" ? canAssign : value === "move_stage" ? canMoveStage : canApplyTags
  )), [canApplyTags, canAssign, canMoveStage]);

  useEffect(() => {
    if (!applied?.operation.undo_expires_at) return;
    const expiresAt = new Date(applied.operation.undo_expires_at).getTime();
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    const expiryTimer = window.setTimeout(() => {
      window.clearInterval(timer);
      setNow(Date.now());
    }, Math.max(0, expiresAt - Date.now()));
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(expiryTimer);
    };
  }, [applied?.operation.undo_expires_at]);

  useEffect(() => {
    if (availableActions.some(({ value }) => value === action)) return;
    const nextAction = availableActions[0]?.value;
    if (nextAction) setAction(nextAction);
  }, [action, availableActions]);
  useEffect(() => { setPreview(null); setApplyKey(null); setTargetId(""); }, [action]);
  useEffect(() => { setPreview(null); setApplyKey(null); }, [selected]);

  const payload = useMemo(() => {
    const base = { action, items: selected };
    if (action === "assign") return { ...base, assigned_member_id: targetId || null };
    if (action === "move_stage") return { ...base, stage_id: targetId };
    return { ...base, tag_ids: targetId ? [targetId] : [] };
  }, [action, selected, targetId]);
  const requiresTarget = action !== "assign";
  const targetReady = requiresTarget ? Boolean(targetId) : true;
  const undoExpiry = applied?.operation.undo_expires_at ? new Date(applied.operation.undo_expires_at).getTime() : 0;
  const undoSeconds = Math.max(0, Math.ceil((undoExpiry - now) / 1000));

  if (organizationEnabled !== true || availableActions.length === 0 || (!selected.length && !applied)) return null;

  async function runPreview() {
    setPending(true); setError(""); setApplied(null);
    try {
      const result = await api<Preview>("/organization/bulk/preview", { method: "POST", body: JSON.stringify(payload) });
      setPreview(result);
      setApplyKey(result.valid ? crypto.randomUUID() : null);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao validar lote"); }
    finally { setPending(false); }
  }

  async function apply() {
    if (!preview?.valid || !applyKey) return;
    setPending(true); setError("");
    try {
      const response = await api<ApplyResponse>("/organization/bulk/apply", { method: "POST", body: JSON.stringify({ ...payload, idempotency_key: applyKey }) });
      setApplied(response); setPreview(null); onClear(); await onChanged(); setNow(Date.now());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao aplicar lote"); }
    finally { setPending(false); }
  }

  async function undo() {
    if (!applied || undoSeconds <= 0) return;
    setPending(true); setError("");
    try { await api(`/organization/bulk/${applied.operation.id}/undo`, { method: "POST" }); setApplied(null); setApplyKey(null); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao desfazer lote"); }
    finally { setPending(false); }
  }

  if (applied) return <aside className="fixed bottom-4 left-1/2 z-20 flex w-[min(620px,calc(100vw-32px))] -translate-x-1/2 items-center gap-3 rounded border border-[var(--ok-border)] bg-[var(--dialog)] p-3 shadow-[0_18px_46px_color-mix(in_srgb,var(--app)_42%,transparent)]" role="status"><CheckSquare size={20} className="text-[var(--ok)]" aria-hidden="true" /><p className="min-w-0 flex-1 text-xs"><strong className="block">{applied.result.count} lead(s) atualizados</strong><span className="text-[var(--muted)]">Operação concluída de forma atômica.</span></p>{applied.result.undoable && undoSeconds > 0 ? <button type="button" className="btn" onClick={() => void undo()} disabled={pending}><ArrowCounterClockwise size={15} />Desfazer · {undoSeconds}s</button> : null}<button type="button" className="grid size-8 place-items-center rounded active:scale-[.94]" onClick={() => setApplied(null)} aria-label="Fechar confirmação"><X size={15} /></button>{error ? <p className="error" role="alert">{error}</p> : null}</aside>;

  return <aside className="fixed bottom-4 left-1/2 z-20 grid w-[min(760px,calc(100vw-32px))] -translate-x-1/2 gap-3 rounded border border-[var(--border-ai)] bg-[var(--dialog)] p-3 shadow-[0_18px_46px_color-mix(in_srgb,var(--app)_42%,transparent)] sm:grid-cols-[auto_minmax(150px,1fr)_minmax(170px,1fr)_auto] sm:items-end" aria-label="Ações em lote">
    <div className="flex items-center gap-2 self-center"><CheckSquare size={19} className="text-[var(--accent)]" /><strong className="text-xs">{selected.length} selecionado(s)</strong></div>
    <label className="field"><span className="label">Ação</span><select className="input" value={action} onChange={(event) => setAction(event.target.value as BulkAction)}>{availableActions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
    <label className="field"><span className="label">Destino</span><select className="input" value={targetId} onChange={(event) => { setTargetId(event.target.value); setPreview(null); setApplyKey(null); }}><option value="">{action === "assign" ? "Sem responsável" : "Selecione"}</option>{action === "move_stage" ? pipelineData?.stages.filter((stage) => !stage.archived_at).map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>) : action === "assign" ? attendantData?.attendants.filter((attendant) => attendant.selected).map((attendant) => <option key={attendant.member_id} value={attendant.member_id}>{attendant.email}{attendant.availability_status === "available" ? " · disponível" : ""}</option>) : tagData?.tags.filter((tag) => !tag.archived_at).map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></label>
    <div className="flex gap-2"><button type="button" className="btn" onClick={onClear}>Cancelar</button>{preview?.valid ? <button type="button" className="btn primary" onClick={() => void apply()} disabled={pending}>{pending ? "Aplicando…" : `Aplicar em ${preview.count}`}</button> : <button type="button" className="btn primary" onClick={() => void runPreview()} disabled={pending || !targetReady}>{pending ? "Validando…" : "Prévia"}</button>}</div>
    {preview && !preview.valid ? <div className="sm:col-span-4 rounded border border-[var(--warn-border)] bg-[var(--warn-bg)] p-2 text-xs text-[var(--warn)]" role="alert"><strong>O lote inteiro foi bloqueado.</strong><ul className="mt-1 list-disc pl-4">{preview.errors.slice(0, 5).map((item) => <li key={`${item.id}:${item.code}`}>{item.message}</li>)}</ul></div> : null}
    {preview?.valid ? <div className="sm:col-span-4 rounded border border-[var(--ok-border)] bg-[var(--ok-bg)] p-2 text-xs text-[var(--ok)]" role="status"><strong>Prévia validada para {preview.count} lead(s).</strong> {preview.undoable ? "Esta ação poderá ser desfeita por 30 segundos." : "Esta mudança de status não poderá ser desfeita pelo atalho."}</div> : null}
    {error ? <p className="error sm:col-span-4" role="alert">{error}</p> : null}
  </aside>;
}
