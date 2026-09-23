"use client";

/* Editor visual de fluxos de robô (R22) — React Flow v12 + dagre.
   Porta a UX do legado (flow-canvas/flow-node-editor do crm-whatsapp):
   paleta por grupos, handles rotulados (Sim/Não/opção), painel de
   propriedades por tipo, auto-organizar, simulação com trace.
   Nós EXISTENTES preservam id estável (o PUT é upsert por id —
   NUNCA delete-all+recreate na UI): o id do nó é a chave da etapa no
   definition, então editar/salvar nunca regera ids. */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import Link from "next/link";
import {
  ArrowsDownUp,
  ChatText,
  ClockCounterClockwise,
  CursorClick,
  FlowIcons,
  Play,
  RailIcons,
  Trash,
  WebhooksLogo,
  X,
} from "@/components/icons";
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  TRIGGER_ID,
  PALETTE_GROUPS,
  graphFromDefinition,
  layoutDefinition,
  newStepFor,
  optionLabel,
  paletteItemForStep,
  removeStep,
  setEdgeTarget,
  stepId,
  stepOptions,
  validateDefinition,
  type FlowDefinition,
  type FlowStep,
  type GraphNode,
  type PaletteItem,
  type Position as XYPos,
} from "./flow-model";
import { FlowConflictModal, type FlowConflict } from "./FlowConflictModal";
import { IconButton, SaveButton, SaveToast, type SaveState } from "@/components/ui";
import styles from "./flow-editor.module.css";

export type SimTrace = {
  running: boolean;
  steps: Array<{ nodeId: string; label: string; output?: string }>;
  endReason?: string;
  error?: string;
};

type FlowEditorProps = {
  flowId: string;
  nome: string;
  ativo: boolean;
  definition: FlowDefinition;
  canManage: boolean;
  saving: boolean;
  /** Legado do feedback antigo ("Salvo." no header) — o estado visível agora é saveState. */
  saved: boolean;
  /** Padrão de salvar DS v2 (§2): idle → busy → done (+ SaveToast 2,6s). */
  saveState?: SaveState;
  serverError: string | null;
  trace: SimTrace | null;
  /** 409 FLOW_VERSION_CONFLICT do save (M3 popula; aqui só a exibição). */
  conflict?: FlowConflict | null;
  onReload?: () => void;
  /** "Ver histórico" do modal: abre o drawer de Histórico da página (não é rota). */
  onOpenHistory?: () => void;
  onNome: (nome: string) => void;
  onDefinition: (definition: FlowDefinition) => void;
  onSave: () => void;
  onSimulate: () => void;
  onCloseTrace: () => void;
};

/* ─── cores por tipo de nó: tokens --nt-* do handoff Cobalto, tema-independente ─── */

const NT: Record<string, string> = {
  trigger: "var(--nt-trigger)",
  message: "var(--nt-message)",
  options: "var(--nt-message)",
  boolean: "var(--nt-condition)",
  text: "var(--nt-message)",
  years: "var(--nt-message)",
  revenue: "var(--nt-message)",
  final: "var(--nt-finalize)",
  delay: "var(--nt-delay)",
  wait_for_reply: "var(--nt-wait)",
  branch: "var(--nt-condition)",
  finalize: "var(--nt-finalize)",
  interactive: "var(--nt-message)",
  tag_add: "var(--nt-tag)",
  tag_remove: "var(--nt-tag)",
  stage_move: "var(--nt-stage)",
  assign_agent: "var(--nt-assign)",
  webhook: "var(--nt-webhook)",
};

const NODE_ICONS: Record<string, typeof ChatText> = {
  trigger: FlowIcons.gatilho,
  message: FlowIcons.mensagem,
  options: FlowIcons.opcoes,
  boolean: FlowIcons.simnao,
  text: FlowIcons.texto,
  years: FlowIcons.opcoes,
  revenue: FlowIcons.opcoes,
  final: FlowIcons.finalizar,
  delay: FlowIcons.espera,
  wait_for_reply: FlowIcons.aguardar,
  branch: FlowIcons.simnao,
  finalize: FlowIcons.finalizar,
  interactive: CursorClick,
  tag_add: FlowIcons.addtag,
  tag_remove: FlowIcons.rmtag,
  stage_move: FlowIcons.etapa,
  assign_agent: FlowIcons.agente,
  webhook: FlowIcons.webhook,
};

function withNt(nodeType: string): CSSProperties {
  return { "--nt": NT[nodeType] ?? NT.webhook } as CSSProperties;
}

function NodeIcon({ nodeType }: { nodeType: string }) {
  const Icon = NODE_ICONS[nodeType] ?? WebhooksLogo;
  return <Icon size={17} strokeWidth={1.9} aria-hidden="true" />;
}

/* ─── nós do canvas ─── */

function StepNode({ data, selected }: NodeProps) {
  const node = data as unknown as GraphNode;
  return (
    <div
      className={styles.node}
      data-selected={selected}
      data-error={Boolean(node.error)}
      style={withNt(node.nodeType)}
      data-testid={`flow-node-${node.id}`}
    >
      <Handle type="target" position={Position.Top} />
      <div className={styles.nodeHead}>
        <span className={styles.nodeIcon}><NodeIcon nodeType={node.nodeType} /></span>
        <div style={{ minWidth: 0 }}>
          <span className={styles.nodeLabel}>{node.label}</span>
          <p className={styles.nodePreview}>{node.preview}</p>
          {node.error ? <p className={styles.nodeError}>{node.error}</p> : null}
        </div>
      </div>
      {node.options.length > 0 ? (
        <div className={styles.nodeChips}>
          {node.options.map((option) => (
            <span key={option} className={styles.nodeChip}>{optionLabel(option)}</span>
          ))}
        </div>
      ) : null}
      {node.options.length > 1
        ? node.options.map((option, index) => (
            <Handle
              key={option}
              id={option}
              type="source"
              position={Position.Bottom}
              style={{ left: `${((index + 1) / (node.options.length + 1)) * 100}%` }}
            />
          ))
        : node.options.length === 1
          /* Etapa com 1 opção: além do "out" (next), renderiza o handle da
             opção — antes a aresta transitions[opção] ficava invisível. */
          ? (
            <>
              <Handle id={node.options[0]} type="source" position={Position.Bottom} style={{ left: "25%" }} />
              <Handle id="out" type="source" position={Position.Bottom} />
            </>
          )
          : <Handle id="out" type="source" position={Position.Bottom} />}
    </div>
  );
}

function TriggerNode({ data, selected }: NodeProps) {
  const node = data as unknown as GraphNode;
  return (
    <div
      className={styles.trigger}
      data-selected={selected}
      style={withNt("trigger")}
      data-testid={`flow-node-${node.id}`}
    >
      <span className={styles.nodeIcon}><NodeIcon nodeType="trigger" /></span>
      <div style={{ minWidth: 0 }}>
        <span className={styles.nodeLabel}>Gatilho</span>
        <p className={styles.nodePreview}>{node.preview}</p>
      </div>
      <Handle id="out" type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { step: StepNode, trigger: TriggerNode };

/* ─── painel de propriedades ─── */

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className={styles.propertyField}>
      <span className="label">{label}</span>
      {children}
      {hint ? <small className={styles.propertiesHint}>{hint}</small> : null}
    </label>
  );
}

/** Campos opcionais vazios são OMITIDOS (backend rejeita string vazia em min(1)). */
function assignField(step: FlowStep, key: string, value: string): FlowStep {
  const next = { ...step } as Record<string, unknown>;
  const trimmed = value.trim();
  if (trimmed) next[key] = trimmed;
  else delete next[key];
  return next as FlowStep;
}

function assignNumberField(step: FlowStep, key: string, value: string): FlowStep {
  const next = { ...step } as Record<string, unknown>;
  const parsed = Math.max(0, Math.round(Number(value)));
  if (Number(value) && parsed > 0) next[key] = parsed;
  else delete next[key];
  return next as FlowStep;
}

/** tag_ids: um uuid por linha no textarea; vazio remove o campo. */
function assignTagIds(step: FlowStep, value: string): FlowStep {
  const ids = value.split("\n").map((line) => line.trim()).filter(Boolean);
  const next = { ...step } as Record<string, unknown>;
  if (ids.length) next.tag_ids = ids;
  else delete next.tag_ids;
  return next as FlowStep;
}

function renameOption(step: FlowStep, oldValue: string, newValue: string): FlowStep {
  const value = newValue.trim();
  if (!value || step.options?.some((option) => option.value === value)) return step;
  const options = (step.options ?? []).map((option) => (option.value === oldValue ? { ...option, value } : option));
  const transitions = { ...(step.transitions ?? {}) };
  if (oldValue in transitions) {
    transitions[value] = transitions[oldValue];
    delete transitions[oldValue];
  }
  const next = { ...step, options, transitions: Object.keys(transitions).length ? transitions : undefined } as FlowStep;
  if (!Object.keys(transitions).length) delete next.transitions;
  return next;
}

/* ─── kinds SPEC v7 (branch/finalize/interactive) — espelho do zod ─────── */

type FlowConditionOperator = NonNullable<FlowStep["operator"]>;

/** Mesmos 7 operadores do flowConditionOperator do backend (flow.ts:79-81). */
const BRANCH_OPERATORS: Array<{ value: FlowConditionOperator; label: string }> = [
  { value: "eq", label: "igual a" },
  { value: "neq", label: "diferente de" },
  { value: "contains", label: "contém" },
  { value: "not_contains", label: "não contém" },
  { value: "starts_with", label: "começa com" },
  { value: "is_empty", label: "está vazio" },
  { value: "is_not_empty", label: "está preenchido" },
];

/** is_empty/is_not_empty não levam valor (conditionValueHidden do backend, flow.ts:337-339). */
function branchValueHidden(operator: FlowStep["operator"]): boolean {
  return operator === "is_empty" || operator === "is_not_empty";
}

/** Troca o operador e LIMPA o value quando o novo operador esconde o campo
    (o zod rejeita value presente com is_empty/is_not_empty — flow.ts:204-205). */
function setBranchOperator(step: FlowStep, operator: string): FlowStep {
  const next = { ...step, operator: operator as FlowStep["operator"] } as FlowStep;
  if (branchValueHidden(next.operator)) delete next.value;
  return next;
}

function addInteractiveButton(step: FlowStep): FlowStep {
  const total = step.options?.length ?? 0;
  return { ...step, options: [...(step.options ?? []), { value: `Opção ${total + 1}` }] } as FlowStep;
}

function removeInteractiveButton(step: FlowStep, value: string): FlowStep {
  const options = (step.options ?? []).filter((option) => option.value !== value);
  const transitions = { ...(step.transitions ?? {}) };
  delete transitions[value];
  const next = { ...step, options, transitions: Object.keys(transitions).length ? transitions : undefined } as FlowStep;
  if (!Object.keys(transitions).length) delete next.transitions;
  return next;
}

function setOptionUrl(step: FlowStep, value: string, url: string): FlowStep {
  const trimmed = url.trim();
  const options = (step.options ?? []).map((option) => {
    if (option.value !== value) return option;
    const nextOption = { ...option };
    if (trimmed) nextOption.url = trimmed;
    else delete nextOption.url;
    return nextOption;
  });
  return { ...step, options } as FlowStep;
}

/** Espelha a url do flowOptionSchema do backend (flow.ts:24): opcional,
    URL completa, ≤500 e http(s). Mensagem acionável para o painel. */
function optionUrlIssue(url: string | undefined): string | null {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.length > 500) return "URL excede 500 caracteres";
  try {
    if (!["http:", "https:"].includes(new URL(trimmed).protocol)) return "URL precisa usar http(s)";
  } catch {
    return "URL inválida";
  }
  return null;
}

type PropertiesProps = {
  node: GraphNode;
  definition: FlowDefinition;
  canManage: boolean;
  onDefinition: (definition: FlowDefinition) => void;
  onDeleteStep: (id: string) => void;
  onClose: () => void;
};

function Properties({ node, definition, canManage, onDefinition, onDeleteStep, onClose }: PropertiesProps) {
  const step = node.id === TRIGGER_ID ? null : definition.steps[node.id] ?? null;
  const item = step ? paletteItemForStep(step) : undefined;

  function setStep(next: FlowStep) {
    if (!step) return;
    onDefinition({ ...definition, steps: { ...definition.steps, [node.id]: next } });
  }

  function setTrigger(patch: Partial<FlowDefinition["triggers"]>) {
    onDefinition({ ...definition, triggers: { ...definition.triggers, ...patch } });
  }

  /** Outras etapas (alvos possíveis de roteamento) e escrita de destino por
      handle — MESMA semântica das arestas do canvas (setEdgeTarget). */
  const otherSteps = Object.keys(definition.steps).filter((id) => id !== node.id);
  function setHandle(handle: string, target: string) {
    onDefinition(setEdgeTarget(definition, node.id, handle, target || null));
  }

  return (
    <aside className={styles.properties} aria-label="Propriedades da etapa">
      <div className={styles.propertiesHead}>
        <span className={styles.propertiesBadge} style={withNt(node.nodeType)}>
          {node.id === TRIGGER_ID ? "Gatilho" : item?.label ?? node.label}
        </span>
        <button type="button" className={styles.propertiesClose} onClick={onClose} aria-label="Fechar propriedades">
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className={styles.propertiesBody}>
        {!canManage ? <p className={styles.propertiesHint}>Somente leitura.</p> : null}

        {node.id === TRIGGER_ID ? (
          <>
            <Field label="Mensagem de abertura">
              <textarea
                className="input"
                rows={3}
                value={definition.intro ?? ""}
                disabled={!canManage}
                onChange={(event) => {
                  const value = event.target.value.trim();
                  const next = { ...definition } as Record<string, unknown>;
                  if (value) next.intro = value;
                  else delete next.intro;
                  onDefinition(next as FlowDefinition);
                }}
              />
              <small className={styles.propertiesHint}>Enviada antes da primeira pergunta.</small>
            </Field>
            <label className={styles.propertyCheck}>
              <input
                type="checkbox"
                checked={definition.triggers.ctwa}
                disabled={!canManage}
                onChange={(event) => setTrigger({ ctwa: event.target.checked })}
              />
              <span>Gatilho CTWA (anúncio com link para o WhatsApp)</span>
            </label>
            <Field label="Palavras-chave" hint="Separadas por vírgula.">
              <input
                className="input"
                value={definition.triggers.keywords.join(", ")}
                disabled={!canManage}
                onChange={(event) => setTrigger({ keywords: event.target.value.split(",").map((word) => word.trim()).filter(Boolean) })}
              />
            </Field>
            {definition.triggers.session_ids.length > 0 ? (
              <p className={styles.propertiesHint}>{definition.triggers.session_ids.length} sessão(ões) WhatsApp configurada(s) por API.</p>
            ) : null}
          </>
        ) : step && item ? (
          <>
            {(step.kind === "options" || step.kind === "boolean" || step.kind === "text" || step.kind === "years" || step.kind === "revenue") ? (
              <Field label="Pergunta">
                <textarea
                  className="input"
                  rows={2}
                  value={step.question ?? ""}
                  disabled={!canManage}
                  onChange={(event) => setStep(assignField(step, "question", event.target.value))}
                />
              </Field>
            ) : null}

            {step.kind === "message" || step.kind === "final" ? (
              <Field label="Mensagem" hint={step.kind === "final" ? "Encerra o fluxo após enviar." : undefined}>
                <textarea
                  className="input"
                  rows={4}
                  value={step.message ?? ""}
                  disabled={!canManage}
                  onChange={(event) => setStep(assignField(step, "message", event.target.value))}
                />
                <small className={styles.propertiesHint}>{(step.message ?? "").length}/4000 caracteres</small>
              </Field>
            ) : null}

            {step.kind === "final" ? (
              <Field label="Classificação">
                <input
                  className="input"
                  value={step.classificacao ?? ""}
                  disabled={!canManage}
                  onChange={(event) => setStep(assignField(step, "classificacao", event.target.value))}
                />
              </Field>
            ) : null}

            {step.kind === "options" || step.kind === "boolean" || step.kind === "years" || step.kind === "revenue" ? (
              <div>
                <span className="label">Opções</span>
                <div className={styles.optionList}>
                  {stepOptions(step).map((value) => (
                    <div key={value} className={styles.optionRow}>
                      <input
                        className="input"
                        value={value}
                        disabled={!canManage || step.kind === "years" || step.kind === "revenue" || step.kind === "boolean"}
                        onChange={(event) => setStep(renameOption(step, value, event.target.value))}
                        aria-label={`Opção ${optionLabel(value)}`}
                      />
                      <span className={styles.optionTarget} data-set={Boolean(step.transitions?.[value] ?? step.next)}>
                        {step.transitions?.[value] || step.next ? "→" : "sem destino"}
                      </span>
                    </div>
                  ))}
                </div>
                {step.kind === "options" && (step.options?.length ?? 0) < 20 ? (
                  <button
                    type="button"
                    className={styles.optionAdd}
                    disabled={!canManage}
                    onClick={() => setStep({ ...step, options: [...(step.options ?? []), { value: `Opção ${(step.options?.length ?? 0) + 1}` }] })}
                  >
                    + opção
                  </button>
                ) : null}
                {step.kind === "options" ? (
                  <Field label="Campo de dados" hint="Nome interno salvo na resposta (a-z0-9_).">
                    <input
                      className="input"
                      value={step.field ?? ""}
                      disabled={!canManage}
                      onChange={(event) => setStep(assignField(step, "field", event.target.value.replace(/[^a-z0-9_]/g, "")))}
                    />
                  </Field>
                ) : null}
              </div>
            ) : null}

            {step.kind === "text" ? (
              <Field label="Campo de dados" hint="Nome interno salvo na resposta (a-z0-9_).">
                <input
                  className="input"
                  value={step.field ?? ""}
                  disabled={!canManage}
                  onChange={(event) => setStep(assignField(step, "field", event.target.value.replace(/[^a-z0-9_]/g, "")))}
                />
              </Field>
            ) : null}

            {step.kind === "delay" ? (
              <Field label="Espera (minutos)" hint="Intervalo antes da próxima etapa (1-1440).">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={1440}
                  value={step.wait_minutes ?? ""}
                  disabled={!canManage}
                  onChange={(event) => setStep(assignNumberField(step, "wait_minutes", event.target.value))}
                />
              </Field>
            ) : null}

            {step.kind === "wait_for_reply" ? (
              <>
                <Field label="Tempo limite (minutos)" hint="Espera a resposta do contato por 1-1440 minutos.">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={1440}
                    value={step.timeout_minutes ?? ""}
                    disabled={!canManage}
                    onChange={(event) => setStep(assignNumberField(step, "timeout_minutes", event.target.value))}
                  />
                </Field>
                <Field label="Se o tempo esgotar" hint="Etapa destino do timeout (obrigatória).">
                  <select
                    className="input"
                    value={step.on_timeout ?? ""}
                    disabled={!canManage}
                    onChange={(event) => setStep(assignField(step, "on_timeout", event.target.value))}
                  >
                    <option value="">— selecionar —</option>
                    {Object.keys(definition.steps).filter((id) => id !== node.id).map((id) => (
                      <option key={id} value={id}>{id}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Se a resposta for inválida" hint="Opcional: etapa destino quando a resposta não confere.">
                  <select
                    className="input"
                    value={step.on_invalid_reply ?? ""}
                    disabled={!canManage}
                    onChange={(event) => setStep(assignField(step, "on_invalid_reply", event.target.value))}
                  >
                    <option value="">— nenhum —</option>
                    {Object.keys(definition.steps).filter((id) => id !== node.id).map((id) => (
                      <option key={id} value={id}>{id}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Variável da resposta" hint="Opcional: nome interno salvo da resposta (a-z0-9_).">
                  <input
                    className="input"
                    value={step.variable_name ?? ""}
                    disabled={!canManage}
                    onChange={(event) => setStep(assignField(step, "variable_name", event.target.value.replace(/[^a-z0-9_]/g, "")))}
                  />
                </Field>
              </>
            ) : null}

            {step.kind === "branch" ? (
              <>
                <Field label="Variável" hint="Nome interno da variável comparada (a-z0-9_, até 100).">
                  <input
                    className="input"
                    value={step.variable_name ?? ""}
                    maxLength={100}
                    disabled={!canManage}
                    onChange={(event) => setStep(assignField(step, "variable_name", event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "")))}
                  />
                </Field>
                <Field label="Operador">
                  <select
                    className="input"
                    value={step.operator ?? "eq"}
                    disabled={!canManage}
                    onChange={(event) => setStep(setBranchOperator(step, event.target.value))}
                  >
                    {BRANCH_OPERATORS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </Field>
                {!branchValueHidden(step.operator) ? (
                  <Field label="Valor" hint="Comparado à variável (até 200 caracteres).">
                    <input
                      className="input"
                      value={step.value ?? ""}
                      maxLength={200}
                      disabled={!canManage}
                      onChange={(event) => setStep(assignField(step, "value", event.target.value))}
                    />
                  </Field>
                ) : null}
                <Field label="Saída Sim" hint="Etapa destino quando a condição vale (obrigatória).">
                  <select
                    className="input"
                    value={step.transitions?.yes ?? ""}
                    disabled={!canManage}
                    onChange={(event) => setHandle("yes", event.target.value)}
                  >
                    <option value="">— selecionar —</option>
                    {otherSteps.map((id) => <option key={id} value={id}>{id}</option>)}
                  </select>
                </Field>
                <Field label="Saída Não" hint="Etapa destino quando a condição não vale (obrigatória).">
                  <select
                    className="input"
                    value={step.transitions?.no ?? ""}
                    disabled={!canManage}
                    onChange={(event) => setHandle("no", event.target.value)}
                  >
                    <option value="">— selecionar —</option>
                    {otherSteps.map((id) => <option key={id} value={id}>{id}</option>)}
                  </select>
                </Field>
              </>
            ) : null}

            {step.kind === "finalize" ? (
              <Field label="Motivo do encerramento" hint="Código interno do motivo (1-200 caracteres).">
                <input
                  className="input"
                  value={step.end_reason ?? ""}
                  maxLength={200}
                  disabled={!canManage}
                  onChange={(event) => setStep(assignField(step, "end_reason", event.target.value))}
                />
              </Field>
            ) : null}

            {step.kind === "interactive" ? (
              <>
                <Field label="Mensagem" hint="Texto enviado junto com os botões.">
                  <textarea
                    className="input"
                    rows={3}
                    value={step.message ?? ""}
                    disabled={!canManage}
                    onChange={(event) => setStep(assignField(step, "message", event.target.value))}
                  />
                </Field>
                <Field label="Texto do botão" hint="Rótulo curto do botão de resposta (1-60 caracteres).">
                  <input
                    className="input"
                    value={step.interactive_button_text ?? ""}
                    maxLength={60}
                    disabled={!canManage}
                    onChange={(event) => setStep(assignField(step, "interactive_button_text", event.target.value))}
                  />
                </Field>
                <div>
                  <span className="label">Botões (1-3)</span>
                  <div className={styles.optionList}>
                    {(step.options ?? []).map((option) => {
                      const urlIssue = optionUrlIssue(option.url);
                      return (
                        <div key={option.value} className={styles.buttonRow}>
                          <input
                            className="input"
                            value={option.value}
                            maxLength={200}
                            aria-label={`Texto do botão ${option.value}`}
                            disabled={!canManage}
                            onChange={(event) => setStep(renameOption(step, option.value, event.target.value))}
                          />
                          <input
                            className="input"
                            value={option.url ?? ""}
                            maxLength={500}
                            placeholder="https:// (opcional)"
                            aria-label={`URL do botão ${option.value}`}
                            disabled={!canManage}
                            onChange={(event) => setStep(setOptionUrl(step, option.value, event.target.value))}
                          />
                          {urlIssue ? <p className={styles.fieldError}>{urlIssue}</p> : null}
                          <select
                            className="input"
                            aria-label={`Destino do botão ${option.value}`}
                            value={step.transitions?.[option.value] ?? step.next ?? ""}
                            disabled={!canManage}
                            onChange={(event) => setHandle(option.value, event.target.value)}
                          >
                            <option value="">— destino padrão —</option>
                            {otherSteps.map((id) => <option key={id} value={id}>{id}</option>)}
                          </select>
                          {(step.options?.length ?? 0) > 1 ? (
                            <button
                              type="button"
                              className={styles.buttonRemove}
                              aria-label={`Remover botão ${option.value}`}
                              disabled={!canManage}
                              onClick={() => setStep(removeInteractiveButton(step, option.value))}
                            >
                              ×
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                  {(step.options?.length ?? 0) < 3 ? (
                    <button type="button" className={styles.optionAdd} disabled={!canManage} onClick={() => setStep(addInteractiveButton(step))}>
                      + botão
                    </button>
                  ) : null}
                  <small className={styles.propertiesHint}>Até 3 botões; URL vira botão de link (http(s), ≤500). Roteamento: destino do botão (transitions) ou destino padrão (next).</small>
                </div>
                <Field label="Destino padrão (next)" hint="Usado por botões sem destino próprio.">
                  <select
                    className="input"
                    value={step.next ?? ""}
                    disabled={!canManage}
                    onChange={(event) => setHandle("out", event.target.value)}
                  >
                    <option value="">— nenhum —</option>
                    {otherSteps.map((id) => <option key={id} value={id}>{id}</option>)}
                  </select>
                </Field>
              </>
            ) : null}

            {step.kind === "action" ? (
              <>
                <Field label="Tipo de ação">
                  <select
                    className="input"
                    value={step.action_type ?? ""}
                    disabled={!canManage}
                    onChange={(event) => setStep(assignField(step, "action_type", event.target.value))}
                  >
                    <option value="">— selecionar —</option>
                    <option value="tag_add">Adicionar tag</option>
                    <option value="tag_remove">Remover tag</option>
                    <option value="stage_move">Mover de etapa</option>
                    <option value="assign_agent">Atribuir agente</option>
                    <option value="webhook">Webhook</option>
                  </select>
                </Field>
                {step.action_type === "tag_add" || step.action_type === "tag_remove" ? (
                  <Field label="Tags (uuid)" hint="Um uuid por linha, até 50.">
                    <textarea
                      className="input"
                      rows={3}
                      value={(step.tag_ids ?? []).join("\n")}
                      disabled={!canManage}
                      onChange={(event) => setStep(assignTagIds(step, event.target.value))}
                    />
                  </Field>
                ) : null}
                {step.action_type === "stage_move" ? (
                  <Field label="Etapa do pipeline (uuid)">
                    <input className="input" value={step.stage_id ?? ""} disabled={!canManage} onChange={(event) => setStep(assignField(step, "stage_id", event.target.value))} />
                  </Field>
                ) : null}
                {step.action_type === "assign_agent" ? (
                  <Field label="Agente (uuid)">
                    <input className="input" value={step.agent_id ?? ""} disabled={!canManage} onChange={(event) => setStep(assignField(step, "agent_id", event.target.value))} />
                  </Field>
                ) : null}
                {step.action_type === "webhook" ? (
                  <Field label="URL do webhook" hint="https para host público (ex.: https://api.exemplo.com/hook).">
                    <input className="input" value={step.webhook_url ?? ""} disabled={!canManage} onChange={(event) => setStep(assignField(step, "webhook_url", event.target.value))} />
                  </Field>
                ) : null}
              </>
            ) : null}

            <p className={styles.propertiesHint}>Destinos definidos pelas arestas no canvas. Duplo clique numa aresta remove.</p>

            <div className={styles.removeStepRow}>
              <IconButton
                label="Remover etapa"
                tone="danger"
                size="sm"
                disabled={!canManage || Object.keys(definition.steps).length <= 1}
                onClick={() => onDeleteStep(node.id)}
              >
                <Trash size={14} aria-hidden="true" />
              </IconButton>
            </div>
          </>
        ) : null}
      </div>
    </aside>
  );
}

/* ─── editor ─── */

function FlowEditorInner(props: FlowEditorProps) {
  const { definition, onDefinition, canManage } = props;
  const reactFlow = useReactFlow();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [positions, setPositions] = useState<Map<string, XYPos>>(() => layoutDefinition(definition));
  const didFitRef = useRef(false);
  const [conflictDismissed, setConflictDismissed] = useState(false);

  const graph = useMemo(() => graphFromDefinition(definition), [definition]);

  /* Fluxo Ativo ou simulação em curso: arestas ciano tracejadas animadas (README §6). */
  const flowing = props.ativo || Boolean(props.trace?.running);

  const rfNodes: Node[] = useMemo(() => {
    let fallbackY = 0;
    for (const position of positions.values()) fallbackY = Math.max(fallbackY, position.y);
    return graph.nodes.map((node) => ({
      id: node.id,
      type: node.id === TRIGGER_ID ? "trigger" : "step",
      position: positions.get(node.id) ?? { x: 40, y: fallbackY + NODE_GAP_Y },
      data: node as unknown as Record<string, unknown>,
      selected: node.id === selectedId,
      deletable: false,
      dragHandle: undefined,
    }));
  }, [graph.nodes, positions, selectedId]);

  const rfEdges: Edge[] = useMemo(
    () => graph.edges
      .filter((edge) => edge.source !== edge.target)
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        label: edge.label,
        markerEnd: { type: MarkerType.ArrowClosed, color: flowing ? "var(--primary)" : "var(--border-strong)" },
        labelStyle: { fill: "var(--text-muted)", fontSize: 10, fontWeight: 500 },
        labelBgStyle: { fill: "var(--surface)", fillOpacity: 0.95 },
      })),
    [graph.edges, flowing],
  );

  useEffect(() => {
    if (didFitRef.current) return;
    didFitRef.current = true;
    const timer = window.setTimeout(() => reactFlow.fitView({ padding: 0.25, duration: 0 }), 60);
    return () => window.clearTimeout(timer);
  }, [reactFlow]);

  /* Conflito NOVO (revisão diferente) reabre o modal mesmo após "Continuar
     editando" — identidade do objeto decide, não um contador. */
  useEffect(() => {
    setConflictDismissed(false);
  }, [props.conflict]);

  const selectedNode = selectedId ? graph.nodes.find((node) => node.id === selectedId) ?? null : null;

  const handleConnect = useCallback((connection: Connection) => {
    if (!canManage || !connection.source || !connection.target || connection.source === connection.target) return;
    onDefinition(setEdgeTarget(definition, connection.source, connection.sourceHandle ?? "out", connection.target));
  }, [canManage, definition, onDefinition]);

  const handleEdgeDoubleClick = useCallback((_event: unknown, edge: Edge) => {
    if (!canManage || edge.source === TRIGGER_ID) return;
    onDefinition(setEdgeTarget(definition, edge.source, edge.sourceHandle ?? "out", null));
  }, [canManage, definition, onDefinition]);

  const handleNodeClick = useCallback((_event: ReactMouseEvent, node: Node) => {
    setSelectedId((current) => (current === node.id ? null : node.id));
  }, []);

  const handlePaneClick = useCallback(() => setSelectedId(null), []);

  const handleNodesChange = useCallback((changes: NodeChange<Node>[]) => {
    const moves: Array<{ id: string; position: XYPos }> = [];
    for (const change of changes) {
      if (change.type === "position" && change.position) moves.push({ id: change.id, position: change.position });
    }
    if (!moves.length) return;
    setPositions((current) => {
      const next = new Map(current);
      for (const move of moves) next.set(move.id, move.position);
      return next;
    });
  }, []);

  const handleAutoLayout = useCallback(() => {
    setPositions(layoutDefinition(definition));
    window.setTimeout(() => reactFlow.fitView({ padding: 0.25, duration: 300 }), 30);
  }, [definition, reactFlow]);

  const handleAddNode = useCallback((item: PaletteItem) => {
    if (!canManage) return;
    const id = stepId();
    const next: FlowDefinition = {
      ...definition,
      start: definition.start && definition.steps[definition.start] ? definition.start : id,
      steps: { ...definition.steps, [id]: newStepFor(item) },
    };
    onDefinition(next);
    setSelectedId(id);
  }, [canManage, definition, onDefinition]);

  const handleDeleteStep = useCallback((id: string) => {
    const next = removeStep(definition, id);
    if (next) onDefinition(next);
    setSelectedId(null);
  }, [definition, onDefinition]);

  const clientIssues = useMemo(() => validateDefinition(definition), [definition]);
  const shownIssues = clientIssues.slice(0, 4);
  const extraIssues = clientIssues.length - shownIssues.length;

  /* R4: issue clicável seleciona/foca a etapa no canvas (abre o painel de
     propriedades e destaca o nó). Etapas com error também ficam marcadas. */
  const handleIssueClick = useCallback((id: string) => {
    setSelectedId(id);
    document.querySelector<HTMLElement>(`[data-testid="flow-node-${id}"]`)?.scrollIntoView?.({ block: "center" });
  }, []);

  return (
    <div className={styles.editor}>
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <Link href="/fluxos" className={styles.backLink} aria-label="Voltar para a lista de fluxos">←</Link>
          <input
            className={`input ${styles.nameInput}`}
            value={props.nome}
            onChange={(event) => props.onNome(event.target.value)}
            disabled={!canManage}
            aria-label="Nome do fluxo"
          />
          <span className={styles.statusPill} data-on={props.ativo}>{props.ativo ? "Ativo" : "Inativo"}</span>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.nodeCount} aria-hidden="true">{graph.nodes.length} blocos</span>
          {props.onOpenHistory ? (
            <IconButton label="Histórico" size="sm" data-testid="flow-history-open" onClick={props.onOpenHistory}>
              <ClockCounterClockwise size={15} aria-hidden="true" />
            </IconButton>
          ) : null}
          <IconButton
            label="Simular"
            size="sm"
            disabled={props.trace?.running}
            data-running={Boolean(props.trace?.running)}
            onClick={props.onSimulate}
          >
            <Play size={15} aria-hidden="true" />
          </IconButton>
          <SaveButton
            state={props.saving ? "busy" : props.saveState ?? "idle"}
            data-testid="flow-save"
            disabled={!canManage}
            onClick={props.onSave}
          >
            Salvar
          </SaveButton>
        </div>
      </header>
      <SaveToast show={props.saveState === "done"}>Fluxo salvo</SaveToast>

      {props.serverError ? <div className={styles.editorError} role="alert">{props.serverError}</div> : null}
      {clientIssues.length > 0 ? (
        <div className={styles.editorError} role="alert">
          <strong>{clientIssues.length} problema(s) no fluxo:</strong>
          <ul className={styles.errorList}>
            {shownIssues.map((issue, index) => (
              <li key={`${issue.stepId ?? "flow"}-${index}`}>
                {issue.stepId ? (
                  <button
                    type="button"
                    className={styles.issueLink}
                    data-testid={`flow-issue-${issue.stepId}`}
                    title="Seleciona a etapa no canvas"
                    onClick={() => handleIssueClick(issue.stepId as string)}
                  >
                    {issue.message}
                  </button>
                ) : (
                  issue.message
                )}
              </li>
            ))}
            {extraIssues > 0 ? <li>… e mais {extraIssues}</li> : null}
          </ul>
        </div>
      ) : null}

      <div className={styles.body} data-with-properties={Boolean(selectedNode)}>
        <aside className={styles.palette} aria-label="Adicionar etapa">
          {PALETTE_GROUPS.map((group) => (
            <section key={group.group} className={styles.paletteGroupBlock}>
              <span className={styles.paletteGroup}>{group.group}</span>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={styles.paletteItem}
                  disabled={!canManage}
                  onClick={() => handleAddNode(item)}
                  style={withNt(item.id)}
                  title={item.hint}
                >
                  <span className={styles.paletteIcon}><NodeIcon nodeType={item.id} /></span>
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.hint}</small>
                  </span>
                </button>
              ))}
            </section>
          ))}
        </aside>

        <div className={styles.canvasWrap} data-testid="flow-canvas" data-flowing={flowing}>
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            onNodesChange={handleNodesChange}
            onConnect={handleConnect}
            onEdgeDoubleClick={handleEdgeDoubleClick}
            onNodeClick={handleNodeClick}
            onPaneClick={handlePaneClick}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.25 }}
            nodesDraggable={canManage}
            nodesConnectable={canManage}
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--border)" />
            <Controls showInteractive={false} showZoom={false} showFitView={false} position="bottom-left" className={styles.zoomControls}>
              <ControlButton onClick={() => void reactFlow.zoomIn({ duration: 200 })} title="Aproximar" aria-label="Aproximar">
                <RailIcons.aproximar size={14} aria-hidden="true" />
              </ControlButton>
              <ControlButton onClick={() => void reactFlow.zoomOut({ duration: 200 })} title="Afastar" aria-label="Afastar">
                <RailIcons.afastar size={14} aria-hidden="true" />
              </ControlButton>
              <ControlButton onClick={() => void reactFlow.fitView({ padding: 0.25, duration: 300 })} title="Ajustar à tela" aria-label="Ajustar à tela">
                <RailIcons.ajustar size={13} strokeWidth={2} aria-hidden="true" />
              </ControlButton>
            </Controls>
            <MiniMap nodeColor={minimapColor} nodeStrokeWidth={3} nodeBorderRadius={6} zoomable pannable className={styles.minimap} />
          </ReactFlow>
          <div className={styles.canvasToolbar}>
            <IconButton label="Organizar" size="sm" title="Reorganiza as etapas automaticamente" onClick={handleAutoLayout}>
              <ArrowsDownUp size={14} aria-hidden="true" />
            </IconButton>
          </div>
        </div>

        {selectedNode ? (
          <Properties
            node={selectedNode}
            definition={definition}
            canManage={canManage}
            onDefinition={onDefinition}
            onDeleteStep={handleDeleteStep}
            onClose={() => setSelectedId(null)}
          />
        ) : null}
      </div>

      {props.trace ? (
        <section className={styles.trace} role="region" aria-label="Resultado da simulação">
          <div className={styles.traceHead}>
            <span>Simulação{props.trace.endReason ? ` · fim: ${props.trace.endReason}` : ""} · {props.trace.steps.length} passo(s)</span>
            <button type="button" className={styles.propertiesClose} onClick={props.onCloseTrace} aria-label="Fechar simulação">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          {props.trace.error ? <p className={styles.propertiesHint} style={{ color: "var(--danger-text)" }}>{props.trace.error}</p> : null}
          <div className={styles.traceSteps}>
            {props.trace.steps.map((step, index) => (
              <div key={`${step.nodeId}-${index}`} className={styles.traceStep}>
                <span className={styles.traceIndex}>{index + 1}.</span>
                <span>
                  <strong>{step.nodeId}</strong>
                  {step.label ? <span className={styles.traceOutput}> · {step.label}</span> : null}
                  {step.output ? <span className={styles.traceOutput}> — {step.output}</span> : null}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {props.conflict && !conflictDismissed ? (
        <FlowConflictModal
          conflict={props.conflict}
          onReload={() => props.onReload?.()}
          onOpenHistory={props.onOpenHistory ? () => props.onOpenHistory?.() : undefined}
          onClose={() => setConflictDismissed(true)}
        />
      ) : null}
    </div>
  );
}

const NODE_GAP_Y = 140;

/* Hexes do handoff (Fluxo.dc.html `const K`). */
function minimapColor(node: Node): string {
  const nodeType = (node.data as unknown as GraphNode)?.nodeType;
  if (nodeType === "trigger") return "#3DDC97";
  return MINIMAP_COLORS[nodeType] ?? "#A8A8B0";
}

const MINIMAP_COLORS: Record<string, string> = {
  message: "#7CC4FF",
  options: "#7CC4FF",
  boolean: "#F5C46B",
  text: "#7CC4FF",
  years: "#7CC4FF",
  revenue: "#7CC4FF",
  final: "#FF7A7A",
  delay: "#F5B94A",
  wait_for_reply: "#FF9F6B",
  branch: "#F5C46B",
  finalize: "#FF7A7A",
  interactive: "#7CC4FF",
  tag_add: "#FF8FB4",
  tag_remove: "#FF8FB4",
  stage_move: "#22D3EE",
  assign_agent: "#C99CFF",
  webhook: "#A8A8B0",
};

export function FlowEditor(props: FlowEditorProps) {
  return (
    <ReactFlowProvider>
      <FlowEditorInner {...props} />
    </ReactFlowProvider>
  );
}
