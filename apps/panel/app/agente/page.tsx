"use client";

import { ArrowCounterClockwise, Power } from "@/components/icons";
import { type ReactNode, useEffect, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Shell } from "@/components/shell";
import { PageHeader } from "@/components/ui/layout";
import { IconButton, SaveButton, SaveToast, Switch, useSaveFeedback } from "@/components/ui";
import { api } from "@/lib/api";
import type { PanelSession } from "@/lib/session";
import { usePermission } from "@/lib/use-permission";
import styles from "../channels-ai.module.css";

type AgentForm = {
  systemPrompt: string;
  aiModel: string;
  openRouterProvider: string;
  temperature: number;
  maxTokens: number;
  reasoningEffort: "low" | "medium" | "high";
  isActive: boolean;
  openRouterApiKey: string;
  clearOpenRouterApiKey: boolean;
  hasOpenRouterApiKey: boolean;
  mediaFallbackAudio: string;
  mediaFallbackImage: string;
  mediaFallbackDocument: string;
  enabledTools: string[];
};

type AgentResponse = {
  agent: {
    system_prompt: string;
    ai_model: string;
    openrouter_provider?: string | null;
    model_params: { temperature?: number; max_tokens?: number; reasoning_effort?: "low" | "medium" | "high" };
    is_active: boolean;
    has_openrouter_api_key: boolean;
    media_fallback_audio: string;
    media_fallback_image: string;
    media_fallback_document: string;
    enabled_tools?: string[];
  } | null;
  available_tools?: string[];
  scope?: "shared" | "connection";
};

export default function Agent() {
  const canManage = usePermission("agent.manage");
  const save = useSaveFeedback();
  const [form, setForm] = useState<AgentForm>();


  const [availableTools, setAvailableTools] = useState<string[]>([]);
  // Nomes salvos que o servidor não oferece mais (releases antigas): avisados e fora do PUT.
  const [obsoleteTools, setObsoleteTools] = useState<string[]>([]);
  const [dirtyState, setDirty] = useState(false);
  const dirty = dirtyState && canManage;
  const [state, setState] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  // Alvo do prompt: "" = compartilhado por todos os números (padrão).
  const [connections, setConnections] = useState<Array<{ id: string; label: string; is_primary: boolean }>>([]);
  const [target, setTarget] = useState("");
  const [scope, setScope] = useState<"shared" | "connection">("shared");
  const [removingOverride, setRemovingOverride] = useState(false);
  const targetNeedsOverride = Boolean(target && scope === "shared");

  const [stateTone, setStateTone] = useState<"info" | "success" | "error">("info");
  // Save em voo: trava síncrona (o `saving` só chega no próximo render) e marcas do rascunho (cada
  // edição) e do alvo (cada troca) no clique — a resposta do PUT só confirma o que ainda está na tela.
  const [saving, setSaving] = useState(false);
  // A trava é de escrita, compartilhada com o status e a remoção do exclusivo: o PUT também grava isActive
  // e desfaria (ou seria desfeito por) um PATCH /agent/status em voo, e recriaria o exclusivo de um DELETE
  // em voo, então nenhuma delas sai junto com outra.
  const writingRef = useRef(false);
  // Alvo e promessa da última escrita: a leitura do mesmo alvo espera por ela.
  const lastWriteRef = useRef<{ target: string; done: Promise<unknown> } | null>(null);
  const editRef = useRef(0);
  const targetGenRef = useRef(0);

  useEffect(() => {
    api<{ connections?: Array<{ id: string; label: string; is_primary: boolean }> }>("/connections")
      .then(({ connections: list }) => setConnections(list ?? []))
      .catch(() => setConnections([]));
  }, []);

  useEffect(() => {
    // O formulário pertence ao alvo: nada se salva nele enquanto o novo carrega (ou se a carga falhar)
    // e a resposta atrasada de um alvo anterior é descartada.
    let current = true;
    setForm(undefined);
    setLoaded(false);
    // Quem sai e volta ao alvo com uma escrita dele em voo o relê depois dela: lido antes, viria com o valor
    // anterior, e o selo e o próximo save repetiriam esse valor.
    const write = lastWriteRef.current;
    const load = () => api<AgentResponse>(target ? `/agent?session_id=${target}` : "/agent");
    (write?.target === target ? write.done.catch(() => undefined).then(load) : load())
      .then(({ agent, available_tools: tools, scope: loadedScope }) => {
        if (!current) return;
        if (!agent) throw new Error("Agente não configurado");
        const known = tools ?? [];
        const obsolete = (agent.enabled_tools ?? []).filter((tool) => !known.includes(tool));
        setAvailableTools(known);
        setObsoleteTools(obsolete);
        setScope(loadedScope ?? "shared");
        const loadedForm: AgentForm = {
          systemPrompt: agent.system_prompt,
          aiModel: agent.ai_model,
          openRouterProvider: agent.openrouter_provider ?? "",
          temperature: agent.model_params.temperature ?? 0.4,
          maxTokens: agent.model_params.max_tokens ?? 512,
          reasoningEffort: agent.model_params.reasoning_effort ?? "medium",
          isActive: agent.is_active,
          openRouterApiKey: "",
          clearOpenRouterApiKey: false,
          hasOpenRouterApiKey: agent.has_openrouter_api_key,
          mediaFallbackAudio: agent.media_fallback_audio,
          mediaFallbackImage: agent.media_fallback_image,
          mediaFallbackDocument: agent.media_fallback_document,
          enabledTools: (agent.enabled_tools ?? []).filter((tool) => known.includes(tool))
        };
        setForm(loadedForm);
        setDirty(obsolete.length > 0);


      })
      .catch((error: unknown) => {
        if (!current) return;
        setStateTone("error");
        setState(error instanceof Error ? error.message : "Erro ao carregar o agente");
      })
      .finally(() => {
        if (current) setLoaded(true);
      });
    return () => {
      current = false;
    };
  }, [target]);

  function change(values: Partial<AgentForm>) {
    if (form && canManage) {
      editRef.current += 1;
      setForm({ ...form, ...values });
      setDirty(true);
    }
  }

  function track<T>(request: Promise<T>) {
    lastWriteRef.current = { target, done: request };
    return request;
  }

  async function saveAgent() {
    if (!form || !canManage || writingRef.current) return;
    const edit = editRef.current;
    const generation = targetGenRef.current;
    writingRef.current = true;
    setSaving(true);
    save.reset();
    setStateTone("info");
    setState("Salvando…");
    try {
      await track(api("/agent", {
        method: "PUT",
        body: JSON.stringify({ ...form, sessionId: target || null })
      }));
      if (targetGenRef.current !== generation) return; // outro alvo na tela: nada deste save vale para ele
      setObsoleteTools([]);
      if (target) setScope("connection");
      if (editRef.current !== edit) {
        setState(""); // o que foi editado em voo segue pendente
        return;
      }
      setDirty(false);
      setStateTone("success");
      setState("Alterações salvas.");
      save.markDone();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erro ao salvar";
      setStateTone("error");
      setState(targetGenRef.current === generation ? message : `Não foi possível salvar as alterações feitas antes da troca: ${message}`);
    } finally {
      writingRef.current = false;
      setSaving(false);
    }
  }

  async function toggleAgent() {
    if (!form || writingRef.current || !canManage) return;
    const next = !form.isActive;
    if (!next && !window.confirm("Desativar totalmente a IA? Novas mensagens continuarão registradas, mas não receberão resposta automática.")) return;
    const generation = targetGenRef.current;
    writingRef.current = true;
    setChangingStatus(true);
    setState("");
    try {
      await track(api("/agent/status", { method: "PATCH", body: JSON.stringify({ isActive: next, sessionId: target || null }) }));
      // A tela trocou de alvo (se voltou a este, o releu depois desta escrita): selo e aviso daqui não valem para ela.
      if (targetGenRef.current !== generation) return;
      setForm((current) => current ? { ...current, isActive: next } : current);
      setStateTone("success");
      setState(next ? "IA ativada" : "IA totalmente desativada");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erro ao alterar o status da IA";
      setStateTone("error");
      setState(targetGenRef.current === generation ? message : `Não foi possível alterar o status da IA antes da troca: ${message}`);
    } finally {
      writingRef.current = false;
      setChangingStatus(false);
    }
  }

  function toggleTool(name: string) {
    if (!form) return;
    change({
      enabledTools: form.enabledTools.includes(name)
        ? form.enabledTools.filter((tool) => tool !== name)
        : [...form.enabledTools, name]
    });
  }

  async function removeOverride() {
    if (!target || !canManage || writingRef.current) return;
    if (!window.confirm("Remover o prompt exclusivo deste número? Ele volta a usar o prompt compartilhado.")) return;
    const generation = targetGenRef.current;
    writingRef.current = true;
    setRemovingOverride(true);
    try {
      await track(api(`/agent/override/${target}`, { method: "DELETE" }));
      // A tela trocou de número (se voltou a este, o releu depois do DELETE): não a leva ao compartilhado.
      if (targetGenRef.current !== generation) return;
      setScope("shared");
      targetGenRef.current += 1;
      save.reset();
      setTarget("");
      setStateTone("success");
      setState("Prompt exclusivo removido. O número voltou ao prompt compartilhado.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erro ao remover o prompt exclusivo";
      setStateTone("error");
      setState(targetGenRef.current === generation ? message : `Não foi possível remover o prompt exclusivo antes da troca: ${message}`);
    } finally {
      writingRef.current = false;
      setRemovingOverride(false);
    }
  }


  return (
    <Shell><div className={`${styles.channelsAiPage} channels-ai-page`}>
      <PageHeader
        title="Agente principal"
        actions={
          <div className="flex flex-wrap items-center justify-end gap-3">
          {connections.length > 1 ? (
            <label className="flex items-center gap-2 text-sm">
              <span className="label">Prompt de</span>
              <select
                className="input"
                aria-label="Número que usa este prompt"
                value={target}
                onChange={(event) => { targetGenRef.current += 1; setState(""); save.reset(); setTarget(event.target.value); }}
              >
                <option value="">Todos os números</option>
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.label}{connection.is_primary ? " (principal)" : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <span className={`mono rounded-full border px-3 py-2 type-caption font-semibold uppercase tracking-[.12em] ${form?.isActive ? "border-[var(--primary-border)] text-[var(--primary-text)]" : "border-[var(--warning-border)] text-[var(--warning-text)]"}`}>
            {form?.isActive ? "IA ligada" : "IA desligada"}
          </span>
          <button type="button" className={`btn active:scale-[.98] ${form?.isActive ? "warn" : "primary"}`} disabled={!canManage || !form || changingStatus || saving || removingOverride || targetNeedsOverride} onClick={toggleAgent}>
            <Power size={16} aria-hidden="true" />
            {changingStatus ? "Alterando…" : form?.isActive ? "Desativar IA" : "Ativar IA"}
          </button>
          <SaveButton type="button" state={saving ? "busy" : save.state} disabled={!canManage || !dirty || !form || form.enabledTools.length === 0 || changingStatus || removingOverride} onClick={() => void saveAgent()}>
            Salvar alterações
          </SaveButton>
          <SaveToast show={save.done}>Agente salvo</SaveToast>
          </div>
        }
      />

      {target && connections.length > 1 ? (
        <p className="sub mb-4" role="status">
          {scope === "connection"
            ? "Este número tem um prompt exclusivo. Alterações aqui não afetam os demais."
            : "Mostrando o prompt compartilhado. Ao salvar, ele vira um prompt exclusivo deste número. Salve as alterações para criar um prompt exclusivo antes de alterar o status deste número."}
          {scope === "connection" && canManage ? (
            <>
              {" "}
              <IconButton type="button" label="Voltar ao prompt compartilhado" size="sm" className="ml-2 align-middle" disabled={removingOverride || saving || changingStatus} onClick={() => void removeOverride()}>
                <ArrowCounterClockwise size={14} aria-hidden="true" />
              </IconButton>
            </>
          ) : null}
        </p>
      ) : null}

      {loaded && form && !canManage ? <p className="sub mb-4" role="status">Acesso somente leitura. As configurações e o estado da IA não podem ser alterados.</p> : null}

      {!loaded ? (
        <div className="skeleton channels-ai-skeleton--large" aria-hidden="true" />
      ) : !form ? (
        <p className="error" role="alert">{state}</p>
      ) : (
        <fieldset className="contents" disabled={!canManage}>
          <div className="agent-layout">
            <section className="agent-main">
              <div className="flex channels-ai-agent-editor flex-col">
                <div className="cardtitle channels-ai-section-title">
                  <span><label htmlFor="agent-system-prompt">Instruções do agente</label> <small className="mono ml-2 type-caption text-[var(--text-muted)]">system_prompt</small></span>
                  <span className="mono type-caption text-[var(--text-muted)]">{form.systemPrompt.length} caracteres</span>
                </div>
                <textarea id="agent-system-prompt" className="input channels-ai-prompt flex-1 resize-none leading-relaxed" value={form.systemPrompt} onChange={(event) => change({ systemPrompt: event.target.value })} />
                <p className="sub mt-3">Proteções contra injeção de prompt, fuga de contexto e exposição de dados continuam ativas automaticamente. O comportamento do atendimento vem do que você escrever aqui.</p>
              </div>
              <div className="line-section grid gap-4">
                <div className="cardtitle channels-ai-section-title">Ferramentas habilitadas</div>
                <p className="sub">O agente só enxerga e executa as ferramentas selecionadas.</p>
                {obsoleteTools.length > 0 ? (
                  <p className="sub warning" role="alert">
                    Ferramentas que não existem mais nesta versão e serão removidas ao salvar: <span className="mono">{obsoleteTools.join(", ")}</span>
                  </p>
                ) : null}
                <div className="grid gap-2 md:grid-cols-2">
                  {availableTools.map((tool) => (
                    <label key={tool} className="flex items-center gap-2 rounded border border-[var(--border)] p-3 text-xs">
                      <input type="checkbox" checked={form.enabledTools.includes(tool)} onChange={() => toggleTool(tool)} />
                      <span className="mono">{tool}</span>
                    </label>
                  ))}
                </div>
                <div className="cardtitle channels-ai-section-title">Respostas para mídia</div>
                <Field label="Áudio"><textarea className="input channels-ai-textarea-compact resize-y" value={form.mediaFallbackAudio} onChange={(event) => change({ mediaFallbackAudio: event.target.value })} /></Field>
                <Field label="Imagem"><textarea className="input channels-ai-textarea-compact resize-y" value={form.mediaFallbackImage} onChange={(event) => change({ mediaFallbackImage: event.target.value })} /></Field>
                <Field label="Documento"><textarea className="input channels-ai-textarea-compact resize-y" value={form.mediaFallbackDocument} onChange={(event) => change({ mediaFallbackDocument: event.target.value })} /></Field>
              </div>
            </section>

            <aside className="agent-side">
              <section className="grid gap-4">
                <div className="cardtitle channels-ai-section-title">OpenRouter</div>
                <Field label="Provider"><input className="input mono text-xs" placeholder="anthropic, openai, google..." value={form.openRouterProvider} onChange={(event) => change({ openRouterProvider: event.target.value })} /></Field>
                <Field label="Modelo"><input className="input mono text-xs" value={form.aiModel} onChange={(event) => change({ aiModel: event.target.value })} /></Field>
                <Field label="Chave da API"><input className="input mono text-xs" type="password" autoComplete="new-password" placeholder={form.hasOpenRouterApiKey ? "Chave configurada · digite para substituir" : "sk-or-v1-..."} value={form.openRouterApiKey} onChange={(event) => change({ openRouterApiKey: event.target.value, clearOpenRouterApiKey: false })} /></Field>
                {form.hasOpenRouterApiKey ? (
                  <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                    <input type="checkbox" checked={form.clearOpenRouterApiKey} onChange={(event) => change({ clearOpenRouterApiKey: event.target.checked, openRouterApiKey: "" })} />
                    Remover chave configurada
                  </label>
                ) : null}
                <p className="sub">Informe o slug do provider da OpenRouter. Em branco, mantém o roteamento automático/global.</p>
                <p className="sub">A chave é criptografada no servidor e nunca é retornada ao navegador.</p>
              </section>
              <section className="line-section grid gap-4">
                <div className="cardtitle channels-ai-section-title">Parâmetros</div>
                <Field label="Nível de raciocínio">
                  <select className="input" value={form.reasoningEffort} onChange={(event) => change({ reasoningEffort: event.target.value as AgentForm["reasoningEffort"] })}>
                    <option value="low">Baixo, mais rápido</option>
                    <option value="medium">Médio, recomendado</option>
                    <option value="high">Alto, mais criterioso</option>
                  </select>
                  <small className="sub">Aplicado a modelos compatíveis. Níveis maiores podem aumentar o tempo e o consumo de tokens.</small>
                </Field>
                <label className="field">
                  <span className="flex justify-between"><span>Temperatura</span><b className="mono text-xs accent">{form.temperature.toFixed(1)}</b></span>
                  <input type="range" min="0" max="2" step="0.1" value={form.temperature} onChange={(event) => change({ temperature: Number(event.target.value) })} />
                </label>
                <label className="field">
                  <span className="flex justify-between"><span>Máx. tokens por resposta</span><b className="mono text-xs accent">{form.maxTokens}</b></span>
                  <input type="range" min="64" max="8192" step="64" value={form.maxTokens} onChange={(event) => change({ maxTokens: Number(event.target.value) })} />
                </label>
              </section>
              {state ? <p className={stateTone === "error" ? "error" : stateTone === "success" ? "accent" : "sub"} role="status" aria-live="polite">{state}</p> : null}
            </aside>
          </div>
        </fieldset>
      )}
      {/* Opção do workspace fora do formulário do alvo: trocar de número não a desmonta com o PUT dela em voo. */}
      <MeetingConfirmationSetting canManage={canManage} />

    </div></Shell>
  );
}


function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span className="label">{label}</span>{children}</label>;
}

type MeetingConfirmationFlags = { flags: { scheduling_meeting_confirmation_v1?: boolean } };

// Opção do workspace (não do número nem do prompt): salva na hora, fora do PUT /agent.
function MeetingConfirmationSetting({ canManage }: { canManage: boolean }) {
  // A chave leva o workspace ativo: trocar de workspace refaz o GET em vez de exibir o valor do anterior.
  const { data: session } = useSWR<PanelSession>("/me", (path: string) => api<PanelSession>(path), { revalidateOnFocus: false, dedupingInterval: 10_000 });
  const workspaceId = session?.activeWorkspace?.id;
  const key = workspaceId ? (["/feature-flags", workspaceId] as const) : null;
  const { data, error } = useSWR(key, ([path]) => api<MeetingConfirmationFlags>(path));
  // Grava na chave do clique: o mutate do useSWR segue a chave atual e, se o workspace mudar durante o PUT, gravaria no novo.
  const { mutate } = useSWRConfig();
  const [saving, setSaving] = useState(false);
  // Trava síncrona: toques no mesmo tick ainda veem o `saving` antigo do closure.
  const savingRef = useRef(false);
  // A mensagem pertence ao workspace em que foi gerada: trocar de workspace a descarta, mesmo com o PUT ainda em curso.
  const [feedback, setFeedback] = useState<{ workspaceId: string | undefined; tone: "success" | "error"; text: string }>();
  if (feedback && feedback.workspaceId !== workspaceId) setFeedback(undefined);
  const status = feedback ?? (error ? { tone: "error", text: "Não foi possível carregar esta opção." } : undefined);

  async function change(enabled: boolean) {
    if (!canManage || !data || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setFeedback(undefined);
    try {
      const saved = await api<{ enabled: boolean }>("/settings/ai-meeting-confirmation", { method: "PUT", body: JSON.stringify({ enabled }) });
      await mutate(key, { flags: { ...data.flags, scheduling_meeting_confirmation_v1: saved.enabled } }, { revalidate: false });
      setFeedback({ workspaceId, tone: "success", text: saved.enabled ? "Confirmação de agendamentos ativada." : "Confirmação de agendamentos desativada." });
    } catch (cause) {
      setFeedback({ workspaceId, tone: "error", text: cause instanceof Error ? cause.message : "Erro ao salvar a confirmação de agendamentos" });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <section className="line-section mt-[var(--space-5)] grid gap-4">
      <div className="cardtitle channels-ai-section-title">Agendamentos pela IA</div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="ai-meeting-confirmation" className="text-sm">Pedir ao contato que confirme agendamentos criados pela IA</label>
        <Switch id="ai-meeting-confirmation" aria-describedby="ai-meeting-confirmation-hint" aria-busy={saving} checked={data?.flags.scheduling_meeting_confirmation_v1 === true} disabled={!canManage || !data || saving} onCheckedChange={(enabled) => void change(enabled)} />
      </div>
      <div className="grid gap-1">
        <p id="ai-meeting-confirmation-hint" className="sub">Vale para todo o workspace, em todos os números. Salva na hora, sem o botão Salvar alterações.</p>
        <p className={status ? (status.tone === "error" ? "error" : "accent") : undefined} role="status" aria-live="polite">{status?.text}</p>
      </div>
    </section>
  );
}
