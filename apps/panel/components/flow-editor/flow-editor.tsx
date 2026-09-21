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
  Clock,
  Eye,
  GitFork,
  Hourglass,
  Kanban,
  Keyboard,
  ListBullets,
  Plug,
  Power,
  Tag,
  UserFocus,
  WebhooksLogo,
  X,
} from "@phosphor-icons/react";
import {
  Background,
  BackgroundVariant,
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
  saved: boolean;
  serverError: string | null;
  trace: SimTrace | null;
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
  tag_add: "var(--nt-tag)",
  tag_remove: "var(--nt-tag)",
  stage_move: "var(--nt-stage)",
  assign_agent: "var(--nt-assign)",
  webhook: "var(--nt-webhook)",
};

const NODE_ICONS: Record<string, typeof ChatText> = {
  trigger: Plug,
  message: ChatText,
  options: ListBullets,
  boolean: GitFork,
  text: Keyboard,
  years: ListBullets,
  revenue: ListBullets,
  final: Power,
  delay: Clock,
  wait_for_reply: Hourglass,
  tag_add: Tag,
  tag_remove: Tag,
  stage_move: Kanban,
  assign_agent: UserFocus,
  webhook: WebhooksLogo,
};

function withNt(nodeType: string): CSSProperties {
  return { "--nt": NT[nodeType] ?? NT.webhook } as CSSProperties;
}

function NodeIcon({ nodeType }: { nodeType: string }) {
  const Icon = NODE_ICONS[nodeType] ?? WebhooksLogo;
  return <Icon size={16} aria-hidden="true" />;
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

            <button
              type="button"
              className={styles.removeStep}
              disabled={!canManage || Object.keys(definition.steps).length <= 1}
              onClick={() => onDeleteStep(node.id)}
            >
              <X size={13} aria-hidden="true" /> Remover etapa
            </button>
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

  const graph = useMemo(() => graphFromDefinition(definition), [definition]);

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
        markerEnd: { type: MarkerType.ArrowClosed, color: "var(--border-strong)" },
        labelStyle: { fill: "var(--text-muted)", fontSize: 10, fontWeight: 500 },
        labelBgStyle: { fill: "var(--surface)", fillOpacity: 0.95 },
      })),
    [graph.edges],
  );

  useEffect(() => {
    if (didFitRef.current) return;
    didFitRef.current = true;
    const timer = window.setTimeout(() => reactFlow.fitView({ padding: 0.25, duration: 0 }), 60);
    return () => window.clearTimeout(timer);
  }, [reactFlow]);

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
          {props.saved && !props.saving ? <span className={`${styles.dirtyNote} ${styles.savedNote}`} role="status">Salvo.</span> : null}
          {props.saving ? <span className={styles.dirtyNote} role="status">Salvando…</span> : null}
        </div>
        <div className={styles.headerActions}>
          <button type="button" className="btn" disabled={props.trace?.running} onClick={props.onSimulate}>
            <Eye size={15} aria-hidden="true" /> Simular
          </button>
          <button type="button" className="btn primary" disabled={!canManage || props.saving} onClick={props.onSave}>
            Salvar
          </button>
        </div>
      </header>

      {props.serverError ? <div className={styles.editorError} role="alert">{props.serverError}</div> : null}
      {clientIssues.length > 0 ? (
        <div className={styles.editorError} role="alert">
          <strong>{clientIssues.length} problema(s) no fluxo:</strong>
          <ul className={styles.errorList}>
            {shownIssues.map((issue, index) => <li key={`${issue.stepId ?? "flow"}-${index}`}>{issue.message}</li>)}
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

        <div className={styles.canvasWrap} data-testid="flow-canvas">
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
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--border)" />
            <Controls showInteractive={false} position="bottom-left" />
            <MiniMap nodeColor={minimapColor} nodeStrokeWidth={3} nodeBorderRadius={6} zoomable pannable className={styles.minimap} />
          </ReactFlow>
          <div className={styles.canvasToolbar}>
            <button type="button" onClick={handleAutoLayout} title="Reorganiza as etapas automaticamente">
              <ArrowsDownUp size={14} aria-hidden="true" /> Organizar
            </button>
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
    </div>
  );
}

const NODE_GAP_Y = 140;

function minimapColor(node: Node): string {
  const nodeType = (node.data as unknown as GraphNode)?.nodeType;
  if (nodeType === "trigger") return "#00ae75";
  return MINIMAP_COLORS[nodeType] ?? "#74889e";
}

const MINIMAP_COLORS: Record<string, string> = {
  message: "#2389e2",
  options: "#2389e2",
  boolean: "#c9a90c",
  text: "#2389e2",
  years: "#2389e2",
  revenue: "#2389e2",
  final: "#e94646",
  delay: "#de9c31",
  wait_for_reply: "#e67339",
  tag_add: "#df5ba2",
  tag_remove: "#df5ba2",
  stage_move: "#6572e4",
  assign_agent: "#c35bca",
  webhook: "#74889e",
};

const PALETTE_GROUPS: Array<{ group: string; items: PaletteItem[] }> = [
  {
    group: "Mensagens",
    items: [
      { id: "message", kind: "message", label: "Mensagem", hint: "Envia um texto", icon: "ChatText" },
      { id: "options", kind: "options", label: "Opções", hint: "Pergunta com ramificações", icon: "ListBullets" },
      { id: "boolean", kind: "boolean", label: "Sim/Não", hint: "Dois caminhos", icon: "GitFork" },
      { id: "text", kind: "text", label: "Texto livre", hint: "Resposta digitada", icon: "Keyboard" },
      { id: "final", kind: "final", label: "Finalizar", hint: "Encerra o fluxo", icon: "Power" },
    ],
  },
  {
    group: "Controle",
    items: [
      { id: "delay", kind: "delay", label: "Espera", hint: "Aguarda N minutos", icon: "Clock" },
      { id: "wait_for_reply", kind: "wait_for_reply", label: "Aguardar resposta", hint: "Pausa até responder", icon: "Hourglass" },
    ],
  },
  {
    group: "Ações CRM",
    items: [
      { id: "tag_add", kind: "action", action: "tag_add", label: "Adicionar tag", hint: "Aplica etiqueta", icon: "Tag" },
      { id: "tag_remove", kind: "action", action: "tag_remove", label: "Remover tag", hint: "Remove etiqueta", icon: "Tag" },
      { id: "stage_move", kind: "action", action: "stage_move", label: "Mover de etapa", hint: "Move no pipeline", icon: "Kanban" },
      { id: "assign_agent", kind: "action", action: "assign_agent", label: "Atribuir agente", hint: "Designa responsável", icon: "UserFocus" },
      { id: "webhook", kind: "action", action: "webhook", label: "Webhook", hint: "Chama URL externa", icon: "WebhooksLogo" },
    ],
  },
];

export function FlowEditor(props: FlowEditorProps) {
  return (
    <ReactFlowProvider>
      <FlowEditorInner {...props} />
    </ReactFlowProvider>
  );
}
