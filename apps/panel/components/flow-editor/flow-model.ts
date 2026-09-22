/* Modelo puro do editor de fluxos de robô (R22) — sem React/DOM.
   Converte o definition do backend (modules/qualification/flow.ts) em
   nós/edges do canvas, valida client-side e aplica o layout dagre.
   Kinds novos (message/delay/wait_for_reply/action) entram com fallback
   grácil: enquanto o backend não os aceitar, o erro do PUT vira mensagem. */

export type FlowStepKind =
  | "years"
  | "revenue"
  | "options"
  | "boolean"
  | "text"
  | "final"
  | "message"
  | "delay"
  | "wait_for_reply"
  | "action"
  /* SPEC v7 C1 — mesmos kinds do zod do backend (flow.ts:3-15). */
  | "branch"
  | "condition"
  | "finalize"
  | "interactive";

/* action_type: enum EXATA do backend (flowActionType em modules/qualification/flow.ts). */
export type FlowAction = "tag_add" | "tag_remove" | "stage_move" | "assign_agent" | "webhook";

export type FlowInteractiveSection = { title: string; rows: Array<{ text: string; description?: string }> };

export type FlowStep = {
  kind: FlowStepKind;
  question?: string;
  field?: string;
  options?: Array<{ value: string; keywords?: string[]; url?: string }>;
  next?: string;
  transitions?: Record<string, string>;
  message?: string;
  classificacao?: string;
  /* Shape EXATO do zod do backend (flowStepSchema): minutos, não segundos;
     action via action_type + campos por tipo (tag_ids/stage_id/agent_id/webhook_url). */
  wait_minutes?: number;
  timeout_minutes?: number;
  variable_name?: string;
  on_timeout?: string;
  on_invalid_reply?: string;
  action_type?: FlowAction;
  tag_ids?: string[];
  stage_id?: string;
  agent_id?: string;
  webhook_url?: string;
  /* SPEC v7 C1: branch/condition, finalize, interactive, webhook method/template. */
  operator?: "eq" | "neq" | "contains" | "not_contains" | "starts_with" | "is_empty" | "is_not_empty";
  value?: string;
  end_reason?: string;
  interactive_type?: "buttons" | "list";
  interactive_button_text?: string;
  interactive_section_title?: string;
  interactive_sections?: FlowInteractiveSection[];
  method?: "GET" | "POST" | "PUT";
  template?: string;
};

export type FlowTriggers = { ctwa: boolean; session_ids: string[]; keywords: string[] };

export type FlowDefinition = {
  start: string;
  intro?: string;
  origem?: string;
  triggers: FlowTriggers;
  steps: Record<string, FlowStep>;
};

export type FlowSummary = {
  id: string;
  nome: string;
  ativo: boolean;
  definition: FlowDefinition;
  atualizado_em: string | null;
};

export type FlowRecord = FlowSummary & { id: string };

/** Nó virtual do gatilho (representa definition.start + triggers). */
export const TRIGGER_ID = "__trigger__";

export const NODE_W = 280;
export const NODE_H = 112;
export const TRIGGER_H = 68;

export type FlowNodeType =
  | "trigger"
  | "message"
  | "options"
  | "boolean"
  | "text"
  | "years"
  | "revenue"
  | "final"
  | "delay"
  | "wait_for_reply"
  | "tag_add"
  | "tag_remove"
  | "stage_move"
  | "assign_agent"
  | "webhook"
  /* SPEC v7 C1 — palette ids para kinds de desvio/finalização/interativo. */
  | "branch"
  | "finalize"
  | "interactive";

export type PaletteItem = {
  id: FlowNodeType;
  kind: FlowStepKind;
  action?: FlowAction;
  label: string;
  hint: string;
  icon: string;
};

export const PALETTE: Array<{ group: string; items: PaletteItem[] }> = [
  {
    group: "Mensagens",
    items: [
      { id: "message", kind: "message", label: "Mensagem", hint: "Envia um texto ao contato", icon: "ChatText" },
      { id: "options", kind: "options", label: "Opções", hint: "Pergunta com opções e ramificações", icon: "ListBullets" },
      { id: "boolean", kind: "boolean", label: "Sim/Não", hint: "Pergunta com Sim ou Não", icon: "GitFork" },
      { id: "text", kind: "text", label: "Texto livre", hint: "Pergunta aberta, resposta digitada", icon: "Keyboard" },
      { id: "final", kind: "final", label: "Finalizar", hint: "Encerra o fluxo com uma mensagem", icon: "Power" },
      { id: "interactive", kind: "interactive", label: "Interativo", hint: "Mensagem com botões ou lista", icon: "CursorClick" },
      { id: "finalize", kind: "finalize", label: "Encerramento", hint: "Encerra o fluxo com motivo interno", icon: "Flag" },
    ],
  },
  {
    group: "Controle",
    items: [
      { id: "delay", kind: "delay", label: "Espera", hint: "Aguarda antes da próxima etapa", icon: "Clock" },
      { id: "wait_for_reply", kind: "wait_for_reply", label: "Aguardar resposta", hint: "Pausa até o contato responder", icon: "Hourglass" },
      { id: "branch", kind: "branch", label: "Condição", hint: "Desvia por variável (sim/não)", icon: "GitBranch" },
    ],
  },
  {
    group: "Ações CRM",
    items: [
      { id: "tag_add", kind: "action", action: "tag_add", label: "Adicionar tag", hint: "Aplica etiqueta(s) ao contato", icon: "Tag" },
      { id: "tag_remove", kind: "action", action: "tag_remove", label: "Remover tag", hint: "Remove etiqueta(s) do contato", icon: "Tag" },
      { id: "stage_move", kind: "action", action: "stage_move", label: "Mover de etapa", hint: "Move no pipeline", icon: "Kanban" },
      { id: "assign_agent", kind: "action", action: "assign_agent", label: "Atribuir agente", hint: "Designa um responsável", icon: "UserFocus" },
      { id: "webhook", kind: "action", action: "webhook", label: "Webhook", hint: "Chama uma URL externa", icon: "WebhooksLogo" },
    ],
  },
];

/* Fonte única dos grupos da paleta — o flow-editor.tsx importa daqui
   (consolidação da PALETTE_GROUPS que vivia duplicada no componente). */
export const PALETTE_GROUPS = PALETTE;

/* Kinds legados (years/revenue) são apenas renderizados, não ofertados na paleta. */
export function newStepFor(item: PaletteItem): FlowStep {
  switch (item.id) {
    case "message": return { kind: "message", message: "" };
    case "options": return { kind: "options", question: "", field: "", options: [{ value: "Opção 1" }] };
    case "boolean": return { kind: "boolean", question: "", options: [{ value: "SIM" }, { value: "NÃO" }] };
    case "text": return { kind: "text", question: "", field: "" };
    case "final": return { kind: "final", message: "" };
    case "delay": return { kind: "delay", wait_minutes: 5 };
    case "wait_for_reply": return { kind: "wait_for_reply", timeout_minutes: 30 };
    case "tag_add": return { kind: "action", action_type: "tag_add", tag_ids: [] };
    case "tag_remove": return { kind: "action", action_type: "tag_remove", tag_ids: [] };
    case "stage_move": return { kind: "action", action_type: "stage_move" };
    case "assign_agent": return { kind: "action", action_type: "assign_agent" };
    case "webhook": return { kind: "action", action_type: "webhook" };
    /* SPEC v7 C1 — defaults espelham o zod do backend (flow.ts:117-127, :122, :124):
       branch sem value pré-preenchido (operator eq exige value); interactive
       buttons com 1 opção (máx 3, roteamento por transitions[value] ou next). */
    case "branch": return { kind: "branch", variable_name: "", operator: "eq", value: "" };
    case "finalize": return { kind: "finalize", end_reason: "" };
    case "interactive":
      return { kind: "interactive", interactive_type: "buttons", message: "", options: [{ value: "Opção 1" }] };
    default: return { kind: "text", question: "", field: "" };
  }
}

export function paletteItemForStep(step: FlowStep): PaletteItem | undefined {
  if (step.kind === "action") {
    return PALETTE.flatMap((group) => group.items).find(
      (item) => item.id === (step.action_type ?? "tag_add"),
    );
  }
  return PALETTE.flatMap((group) => group.items).find((item) => item.kind === step.kind);
}

export function stepId(): string {
  return `n_${randomUuid().replace(/-/g, "").slice(0, 12)}`;
}

function randomUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `u${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
}

/* ─── definition → grafo ──────────────────────────────────────────────── */

export type GraphNode = {
  id: string;
  nodeType: FlowNodeType;
  label: string;
  preview: string;
  options: string[];
  error?: string;
};

export type GraphEdge = { id: string; source: string; target: string; sourceHandle: string; label?: string };

export function optionLabel(value: string): string {
  if (value.toUpperCase() === "SIM" || value.toUpperCase() === "YES") return "Sim";
  if (value.toUpperCase() === "NÃO" || value.toUpperCase() === "NAO" || value.toUpperCase() === "NO") return "Não";
  return value;
}

/** Rótulo legível dos operadores de condição (branch/condition). */
export function operatorLabel(operator: FlowStep["operator"]): string {
  switch (operator) {
    case "eq": return "=";
    case "neq": return "≠";
    case "contains": return "contém";
    case "not_contains": return "não contém";
    case "starts_with": return "começa com";
    case "is_empty": return "vazio";
    case "is_not_empty": return "preenchido";
    default: return "?";
  }
}

const OPTION_KINDS: FlowStepKind[] = ["years", "revenue", "options", "boolean"];

/** Escolhas de um nó interactive — mesma regra de interactiveChoices do backend (flow.ts:371-377). */
export function interactiveChoices(step: FlowStep): string[] {
  if (step.interactive_type === "list") {
    return (step.interactive_sections ?? []).flatMap((section) =>
      section.rows.map((row) => row.text)).filter(Boolean);
  }
  return (step.options ?? []).map((option) => option.value).filter(Boolean);
}

export function stepOptions(step: FlowStep): string[] {
  if (step.kind === "branch" || step.kind === "condition") return ["yes", "no"];
  if (step.kind === "interactive") return interactiveChoices(step);
  if (!OPTION_KINDS.includes(step.kind)) return [];
  return (step.options ?? []).map((option) => option.value).filter(Boolean);
}

export function nodePreview(step: FlowStep): string {
  const cut = (text: string | undefined, size = 52) => (text ?? "").trim().slice(0, size) || "—";
  switch (step.kind) {
    case "message": return cut(step.message, 60);
    case "final": return cut(step.message, 60);
    case "delay": return step.wait_minutes ? `Aguardar ${step.wait_minutes} min` : "Aguardar…";
    case "wait_for_reply": return step.timeout_minutes ? `Esperar resposta · ${step.timeout_minutes} min` : "Esperar resposta";
    case "action":
      switch (step.action_type) {
        case "tag_add": return `Adicionar tag: ${step.tag_ids?.length ?? 0} etiqueta(s)`;
        case "tag_remove": return `Remover tag: ${step.tag_ids?.length ?? 0} etiqueta(s)`;
        case "stage_move": return `Etapa: ${cut(step.stage_id, 30)}`;
        case "assign_agent": return `Atribuir: ${cut(step.agent_id, 30)}`;
        case "webhook": return `Webhook: ${cut(step.webhook_url, 40)}`;
        default: return "Ação CRM";
      }
    case "branch":
    case "condition": {
      const value = step.operator === "is_empty" || step.operator === "is_not_empty"
        ? "(sem valor)"
        : step.value ?? "?";
      return `${step.variable_name ?? "?"} ${operatorLabel(step.operator)} ${value}`;
    }
    case "finalize": return `Encerra: ${cut(step.end_reason ?? "", 40)}`;
    case "interactive": return cut(step.message ?? interactiveChoices(step).join(" · "), 60);
    default: return cut(step.question);
  }
}

export function graphFromDefinition(def: FlowDefinition): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const issues = validateDefinition(def);
  const issueByStep = new Map<string, string>();
  for (const issue of issues) {
    if (issue.stepId) issueByStep.set(issue.stepId, issue.message);
  }

  for (const [id, step] of Object.entries(def.steps ?? {})) {
    const item = paletteItemForStep(step);
    nodes.push({
      id,
      nodeType: item?.id ?? "message",
      label: item?.label ?? step.kind,
      preview: nodePreview(step),
      options: stepOptions(step),
      error: issueByStep.get(id),
    });
    if (step.next) {
      edges.push({ id: `${id}:out`, source: id, target: step.next, sourceHandle: "out" });
    }
    for (const [value, target] of Object.entries(step.transitions ?? {})) {
      if (!target) continue;
      edges.push({ id: `${id}:opt:${value}`, source: id, target, sourceHandle: value, label: optionLabel(value) });
    }
  }

  const hasStart = def.start && def.steps?.[def.start];
  if (hasStart) {
    edges.unshift({ id: `${TRIGGER_ID}:out`, source: TRIGGER_ID, target: def.start, sourceHandle: "out" });
  }
  nodes.unshift({
    id: TRIGGER_ID,
    nodeType: "trigger",
    label: "Gatilho",
    preview: triggerPreview(def),
    options: [],
  });
  return { nodes, edges };
}

export function triggerPreview(def: FlowDefinition): string {
  const triggers = def.triggers ?? { ctwa: false, session_ids: [], keywords: [] };
  const parts: string[] = [];
  if (triggers.ctwa) parts.push("CTWA");
  if (triggers.keywords.length) parts.push(`“${triggers.keywords[0]}”${triggers.keywords.length > 1 ? ` +${triggers.keywords.length - 1}` : ""}`);
  if (triggers.session_ids.length) parts.push(`${triggers.session_ids.length} sessão(ões)`);
  return parts.length ? parts.join(" · ") : "Sem gatilho configurado";
}

/** Resumo de gatilhos para a lista de fluxos. */
export function triggerSummary(def: FlowDefinition): string {
  const triggers = def.triggers ?? { ctwa: false, session_ids: [], keywords: [] };
  const parts: string[] = [];
  if (triggers.ctwa) parts.push("CTWA");
  if (triggers.keywords.length) parts.push(`${triggers.keywords.length} palavra(s)-chave`);
  if (triggers.session_ids.length) parts.push(`${triggers.session_ids.length} sessão(ões)`);
  return parts.length ? `Gatilhos: ${parts.join(" · ")}` : "Sem gatilho";
}

/* ─── mutations ───────────────────────────────────────────────────────── */

export function setEdgeTarget(
  def: FlowDefinition,
  sourceId: string,
  sourceHandle: string,
  target: string | null,
): FlowDefinition {
  const step = def.steps[sourceId];
  if (!step) return def;
  if (sourceHandle === "out") {
    const next = { ...step };
    if (target) next.next = target;
    else delete next.next;
    return withStep(def, sourceId, next);
  }
  const transitions: Record<string, string> = { ...(step.transitions ?? {}) };
  if (target) transitions[sourceHandle] = target;
  else delete transitions[sourceHandle];
  const next = { ...step, transitions: Object.keys(transitions).length ? transitions : undefined };
  if (!Object.keys(transitions).length) delete next.transitions;
  return withStep(def, sourceId, next);
}

function withStep(def: FlowDefinition, id: string, step: FlowStep): FlowDefinition {
  const steps = { ...def.steps, [id]: step };
  return { ...def, steps };
}

export function removeStep(def: FlowDefinition, id: string): FlowDefinition | null {
  const remaining = Object.keys(def.steps).filter((stepId) => stepId !== id);
  if (!remaining.length) return null; // nunca deixa o grafo vazio
  const steps: Record<string, FlowStep> = {};
  for (const [stepId, source] of Object.entries(def.steps)) {
    if (stepId === id) continue;
    const next = { ...source };
    if (next.next === id) delete next.next;
    if (next.on_timeout === id) delete next.on_timeout;
    if (next.on_invalid_reply === id) delete next.on_invalid_reply;
    if (next.transitions && Object.values(next.transitions).includes(id)) {
      const transitions = { ...next.transitions };
      for (const [value, target] of Object.entries(transitions)) {
        if (target === id) delete transitions[value];
      }
      if (Object.keys(transitions).length) next.transitions = transitions;
      else delete next.transitions;
    }
    steps[stepId] = next;
  }
  const start = def.start === id ? remaining[0] : def.start;
  return { ...def, start, steps };
}

/* ─── layout (dagre) ──────────────────────────────────────────────────── */

export type Position = { x: number; y: number };

export function layoutDefinition(def: FlowDefinition): Map<string, Position> {
  const { nodes, edges } = graphFromDefinition(def);
  const graph = new Dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 80 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) {
    graph.setNode(node.id, { width: NODE_W, height: node.id === TRIGGER_ID ? TRIGGER_H : NODE_H });
  }
  for (const edge of edges) graph.setEdge(edge.source, edge.target);
  Dagre.layout(graph);
  const positions = new Map<string, Position>();
  for (const node of nodes) {
    const raw = graph.node(node.id) as { x: number; y: number } | undefined;
    const height = node.id === TRIGGER_ID ? TRIGGER_H : NODE_H;
    positions.set(node.id, raw
      ? { x: raw.x - NODE_W / 2, y: raw.y - height / 2 }
      : { x: 40, y: 40 });
  }
  return positions;
}

/* ─── validação (espelha o zod do backend; server é autoridade final) ──── */

export type ValidationIssue = { stepId?: string; message: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Copiado do backend (flow.ts): webhook de fluxo só sai por https p/ host público. */
function isInternalIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254) || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

function isInternalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host.includes(":")) {
    if (/^::ffff:/i.test(host)) return true;
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isInternalIPv4(mapped[1]);
    return host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe80/.test(host);
  }
  if (!host.includes(".")) return true;
  const parts = host.split(".");
  const looksLikeIPv4 = parts.length === 4 && parts.every((part) => /^\d+$/.test(part));
  if (!looksLikeIPv4) return false;
  return isInternalIPv4(host);
}

function webhookUrlIssue(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "URL do webhook inválida";
  }
  if (url.length > 2_000) return "URL do webhook excede 2000 caracteres";
  if (!url.startsWith("https://")) return "Webhook precisa usar https://";
  if (isInternalHost(parsed.hostname)) return "Webhook não pode apontar para host interno";
  return null;
}

function minutesIssue(value: number | undefined, id: string, field: string): string | null {
  if (!value || !Number.isInteger(value) || value < 1 || value > 1_440) {
    return `Etapa "${id}" precisa de ${field} (1-1440)`;
  }
  return null;
}

/** Todas as saídas do grafo — mesma regra de stepTargets do backend. */
function stepTargets(step: FlowStep): string[] {
  return [
    step.next,
    step.on_timeout,
    step.on_invalid_reply,
    ...Object.values(step.transitions ?? {}),
  ].filter((target): target is string => Boolean(target));
}

export function validateDefinition(def: FlowDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const steps = def.steps ?? {};
  const ids = Object.keys(steps);
  if (!ids.length) {
    issues.push({ message: "O fluxo precisa de ao menos uma etapa." });
    return issues;
  }
  if (!def.start || !steps[def.start]) {
    issues.push({ message: "Ligue o gatilho a uma etapa inicial (aresta do gatilho)." });
  }
  for (const [id, step] of Object.entries(steps)) {
    for (const target of new Set(stepTargets(step))) {
      if (!steps[target]) issues.push({ stepId: id, message: `Etapa "${id}" aponta para etapa inexistente "${target}"` });
    }
    const kind = step.kind;
    if (kind === "final") {
      if (!step.message?.trim()) issues.push({ stepId: id, message: `Etapa final "${id}" precisa de mensagem` });
      continue;
    }
    if (kind === "message") {
      if (!step.message?.trim()) issues.push({ stepId: id, message: `Etapa "${id}" precisa de mensagem` });
      if (!step.next) issues.push({ stepId: id, message: `Etapa "${id}" precisa de destino (aresta de saída)` });
      continue;
    }
    if (kind === "delay") {
      const minutes = minutesIssue(step.wait_minutes, id, "wait_minutes");
      if (minutes) issues.push({ stepId: id, message: minutes });
      if (!step.next) issues.push({ stepId: id, message: `Etapa "${id}" precisa de destino (aresta de saída)` });
      continue;
    }
    if (kind === "wait_for_reply") {
      const timeout = minutesIssue(step.timeout_minutes, id, "timeout_minutes");
      if (timeout) issues.push({ stepId: id, message: timeout });
      if (!step.on_timeout) issues.push({ stepId: id, message: `Etapa "${id}" precisa de on_timeout (etapa destino do tempo esgotado)` });
      if (!step.next) issues.push({ stepId: id, message: `Etapa "${id}" precisa de destino (aresta de saída)` });
      continue;
    }
    if (kind === "action") {
      if (!step.action_type) {
        issues.push({ stepId: id, message: `Etapa de ação "${id}" precisa de action_type` });
      } else if (step.action_type === "tag_add" || step.action_type === "tag_remove") {
        if (!step.tag_ids?.length) issues.push({ stepId: id, message: `Etapa de ação "${id}" (${step.action_type}) precisa de tag_ids` });
        else if (step.tag_ids.length > 50 || step.tag_ids.some((tag) => !UUID_RE.test(tag))) {
          issues.push({ stepId: id, message: `tag_ids da etapa "${id}" precisa de até 50 uuid(s) válidos` });
        }
      } else if (step.action_type === "stage_move") {
        if (!step.stage_id || !UUID_RE.test(step.stage_id)) issues.push({ stepId: id, message: `Etapa de ação "${id}" (stage_move) precisa de stage_id (uuid)` });
      } else if (step.action_type === "assign_agent") {
        if (!step.agent_id || !UUID_RE.test(step.agent_id)) issues.push({ stepId: id, message: `Etapa de ação "${id}" (assign_agent) precisa de agent_id (uuid)` });
      } else if (step.action_type === "webhook") {
        const urlIssue = step.webhook_url ? webhookUrlIssue(step.webhook_url) : "URL do webhook vazia";
        if (urlIssue) issues.push({ stepId: id, message: `Etapa de ação "${id}" (webhook): ${urlIssue}` });
      }
      if (!step.next) issues.push({ stepId: id, message: `Etapa "${id}" precisa de destino (aresta de saída)` });
      continue;
    }
    if (kind === "text") {
      if (!step.question?.trim()) issues.push({ stepId: id, message: `Etapa "${id}" precisa de pergunta` });
      if (!step.next) issues.push({ stepId: id, message: `Etapa "${id}" precisa de destino (aresta de saída)` });
      continue;
    }
    /* SPEC v7 C1 — mesmas regras do zod do backend (flow.ts:200-242).
       Sem estes casos o editor recusava salvamento de fluxos válidos
       (falso-positivo "precisa de pergunta/opções" em nós de desvio). */
    if (kind === "branch" || kind === "condition") {
      if (!step.variable_name?.trim()) {
        issues.push({ stepId: id, message: `Etapa "${id}" (${kind}) precisa de variable_name` });
      }
      if (!step.operator) {
        issues.push({ stepId: id, message: `Etapa "${id}" (${kind}) precisa de operator` });
      } else if (step.operator === "is_empty" || step.operator === "is_not_empty") {
        if (step.value) issues.push({ stepId: id, message: `Etapa "${id}" (${step.operator}) não aceita valor (campo oculto)` });
      } else if (!step.value?.trim()) {
        issues.push({ stepId: id, message: `Etapa "${id}" (${step.operator}) precisa de value` });
      }
      if (!step.transitions?.yes) issues.push({ stepId: id, message: `Etapa "${id}" (${kind}) precisa de saída "yes"` });
      if (!step.transitions?.no) issues.push({ stepId: id, message: `Etapa "${id}" (${kind}) precisa de saída "no"` });
      continue;
    }
    if (kind === "finalize") {
      if (!step.end_reason?.trim()) issues.push({ stepId: id, message: `Etapa de finalização "${id}" precisa de end_reason` });
      continue;
    }
    if (kind === "interactive") {
      if (!step.interactive_type) {
        issues.push({ stepId: id, message: `Etapa interativa "${id}" precisa de interactive_type` });
      } else if (step.interactive_type === "buttons") {
        if (!step.options?.length) issues.push({ stepId: id, message: `Etapa interativa "${id}" (buttons) precisa de opções` });
        else if (step.options.length > 3) issues.push({ stepId: id, message: `Etapa interativa "${id}" (buttons) aceita no máximo 3 botões` });
      } else {
        if (!step.interactive_sections?.length) {
          issues.push({ stepId: id, message: `Etapa interativa "${id}" (list) precisa de interactive_sections` });
        } else {
          const totalRows = step.interactive_sections.reduce((total, section) => total + section.rows.length, 0);
          if (totalRows > 10) issues.push({ stepId: id, message: `Etapa interativa "${id}" (list) aceita no máximo 10 linhas somadas (hoje: ${totalRows})` });
        }
      }
      for (const choice of interactiveChoices(step)) {
        if (!(step.transitions?.[choice] ?? step.next)) {
          issues.push({ stepId: id, message: `Escolha "${choice}" da etapa interativa "${id}" não tem etapa seguinte` });
        }
      }
      continue;
    }
    // years / revenue / options / boolean
    if (!step.question?.trim()) issues.push({ stepId: id, message: `Etapa "${id}" precisa de pergunta` });
    if (!step.options?.length) issues.push({ stepId: id, message: `Etapa "${id}" precisa de opções` });
    for (const option of step.options ?? []) {
      if (!(step.transitions?.[option.value] ?? step.next)) {
        issues.push({ stepId: id, message: `Opção "${option.value}" da etapa "${id}" não tem etapa seguinte` });
      }
    }
    if (!step.next && !step.transitions) {
      issues.push({ stepId: id, message: `Etapa "${id}" precisa de next ou transitions` });
    }
  }
  return issues;
}

/* ─── simulate ────────────────────────────────────────────────────────── */

export type TraceStep = { nodeId: string; label: string; output?: string };
export type Trace = { steps: TraceStep[]; endReason?: string };

export function parseTrace(payload: unknown): Trace {
  const body = (payload ?? {}) as Record<string, unknown>;
  const rawSteps = Array.isArray(body.steps) ? body.steps : Array.isArray(body.trace) ? body.trace : [];
  const steps: TraceStep[] = [];
  for (const raw of rawSteps) {
    const item = (raw ?? {}) as Record<string, unknown>;
    steps.push({
      nodeId: String(item.nodeId ?? item.node_id ?? item.node ?? ""),
      /* Contrato real do backend (routes.ts:447 → service.ts FlowSimulateTraceItem):
         kind = tipo do nó, result = o que aconteceria. label/name/output eram
         chaves que o backend nunca envia — o traço aparecia vazio. */
      label: String(item.label ?? item.kind ?? item.name ?? ""),
      output: (item.output ?? item.result) != null
        ? String(item.output ?? item.result).slice(0, 400)
        : undefined,
    });
  }
  const endReason = body.endReason ?? body.end_reason;
  return { steps, endReason: endReason != null ? String(endReason) : undefined };
}

/* ─── starter p/ fluxo novo (válido no schema atual do backend) ───────── */

export function starterDefinition(): FlowDefinition {
  return {
    start: "E1",
    origem: "facebook",
    intro: "",
    triggers: { ctwa: false, session_ids: [], keywords: [] },
    steps: { E1: { kind: "final", message: "Obrigado! Em breve nossa equipe entra em contato." } },
  };
}

/** O id do fluxo é slug no backend (^[a-z0-9]+(?:-[a-z0-9]+)*$). */
export function newFlowId(): string {
  return `fluxo-${randomUuid().replace(/-/g, "").slice(0, 12)}`;
}

/** Definition cru vindo da API pode faltar campos — normaliza antes do editor. */
export function normalizeDefinition(raw: unknown): FlowDefinition {
  const source = (raw ?? {}) as Record<string, unknown>;
  const triggers = (source.triggers ?? {}) as Record<string, unknown>;
  const steps: Record<string, FlowStep> = {};
  for (const [id, value] of Object.entries((source.steps ?? {}) as Record<string, unknown>)) {
    const step = (value ?? {}) as Record<string, unknown>;
    steps[id] = {
      ...(step as FlowStep),
      kind: (step.kind ?? "final") as FlowStepKind,
      options: Array.isArray(step.options) ? (step.options as FlowStep["options"]) : undefined,
      transitions: step.transitions && typeof step.transitions === "object" ? (step.transitions as Record<string, string>) : undefined,
    };
  }
  return {
    start: typeof source.start === "string" ? source.start : "",
    intro: typeof source.intro === "string" ? source.intro : undefined,
    origem: typeof source.origem === "string" ? source.origem : "facebook",
    triggers: {
      ctwa: triggers.ctwa === true,
      session_ids: Array.isArray(triggers.session_ids) ? (triggers.session_ids as string[]).map(String) : [],
      keywords: Array.isArray(triggers.keywords) ? (triggers.keywords as string[]).map(String) : [],
    },
    steps,
  };
}

import Dagre from "@dagrejs/dagre";
