"use client";

import { ArrowBendUpLeft, Check, File, MagicWand, Microphone, Paperclip, PaperPlaneRight, X } from "@/components/icons";
import { type ClipboardEvent, type FormEvent, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { VoiceInput, VoiceMessagePlayer } from "@/components/ui/voice-input";
import { Button, HelpHint, Input, Textarea, Tooltip } from "@/components/ui";
import { api } from "@/lib/api";
import { audioDisplayName } from "@/lib/audio-waveform";
import { confirmedFailedSend, definitiveProviderRejection } from "@/lib/conversation-send";
import { randomUUID, shouldSubmitOnEnter, submitForm } from "@/lib/compat";
import { ConversationQuickReplies, type ConversationQuickRepliesHandle } from "@/components/conversation-quick-replies";
import styles from "@/components/conversation-quick-replies.module.css";

type MediaType = "audio" | "image" | "video" | "document";
type Attachment = { file: globalThis.File; mediaType: MediaType };
type CopilotSuggestion = { suggestion: string; context_complete: boolean; messages_used: number; messages_total: number };
export type ReplyTarget = { id: string; content: string; sender: "contact" | "agent" | "human" };

export type ConversationComposerCapabilities = {
  channel: "whatsapp" | "instagram";
  can_send: boolean;
  reason: string | null;
  window_expires_at: string | null;
  text: boolean;
  image: boolean;
  audio: boolean;
  video: boolean;
  document: boolean;
};

const ACCEPTED_FILES: Record<MediaType, string> = {
  image: "image/jpeg,image/png,image/webp,image/gif",
  video: "video/*",
  audio: "audio/*",
  document: ".pdf,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.rtf"
};
const MEDIA_LABELS: Record<MediaType, string> = {
  audio: "Áudio",
  image: "Imagem",
  video: "Vídeo",
  document: "Documento"
};
const MAX_BYTES: Record<MediaType, number> = {
  audio: 16 * 1024 * 1024,
  image: 16 * 1024 * 1024,
  video: 32 * 1024 * 1024,
  document: 32 * 1024 * 1024
};

function attachmentType(file: globalThis.File): MediaType {
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  return "document";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileBase64(file: globalThis.File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Falha ao ler o arquivo"));
    reader.onload = () => resolve(String(reader.result ?? "").replace(/^data:[^,]*;base64,/i, ""));
    reader.readAsDataURL(file);
  });
}

export function ConversationComposer({
  conversationId,
  channel = "whatsapp",
  contactName,
  replyTo,
  onCancelReply,
  onSent,
  onError,
  capabilities,
  capabilitiesError
}: {
  conversationId: string;
  channel?: "whatsapp" | "instagram";
  contactName?: string | null;
  replyTo?: ReplyTarget | null;
  onCancelReply?: () => void;
  onSent: () => Promise<void> | void;
  onError: (message: string) => void;
  capabilities?: ConversationComposerCapabilities;
  capabilitiesError?: unknown;
}) {
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const quickRepliesRef = useRef<ConversationQuickRepliesHandle>(null);
  const compositionActiveRef = useRef(false);
  const compositionJustEndedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRecordingRef = useRef(false);
  const recordingTimerRef = useRef<number | null>(null);
  const sendAttemptRef = useRef<{ signature: string; key: string } | null>(null);
  const [suggestion, setSuggestion] = useState<CopilotSuggestion | null>(null);
  const [generating, setGenerating] = useState(false);
  const copilotRequestRef = useRef<object | null>(null);
  const channelCapabilities = capabilities?.channel === channel ? capabilities : undefined;
  const capabilitiesUnavailable = channel === "instagram" && (!channelCapabilities || Boolean(capabilitiesError));
  const windowExpiresAt = channelCapabilities?.window_expires_at
    ? new Date(channelCapabilities.window_expires_at).getTime()
    : null;
  const windowExpired = channel === "instagram"
    && windowExpiresAt !== null
    && Number.isFinite(windowExpiresAt)
    && now >= windowExpiresAt;
  const canSend = !capabilitiesUnavailable && !windowExpired && (channelCapabilities?.can_send ?? true);
  const supports = (mediaType: MediaType) => canSend && (channelCapabilities?.[mediaType] ?? (channel !== "instagram" && mediaType !== "video"));
  const canSendText = canSend && (channelCapabilities?.text ?? channel !== "instagram");
  // O rascunho só aceita texto (digitado ou sugestão da IA) quando o canal permite enviá-lo.
  const draftLocked = sending || recording || attachment?.mediaType === "audio" || !canSendText;
  const canAttach = (["image", "audio", "video", "document"] as const).some(supports);
  const acceptedFiles = (["image", "video", "audio", "document"] as const)
    .filter(supports)
    .map((mediaType) => ACCEPTED_FILES[mediaType])
    .join(",");
  const availabilityMessage = capabilitiesUnavailable
    ? capabilitiesError
      ? "Não foi possível verificar as permissões de envio do Instagram. Tente novamente."
      : "Verificando as permissões de envio do Instagram…"
    : windowExpired
      ? "A janela de 24 horas do Instagram expirou. Aguarde uma nova mensagem do contato."
      : !canSend
        ? channelCapabilities?.reason ?? "Este canal não pode enviar mensagens agora."
        : "";

  useEffect(() => {
    setNow(Date.now());
    if (windowExpiresAt === null || !Number.isFinite(windowExpiresAt)) return;
    const delay = windowExpiresAt - Date.now();
    if (delay <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [windowExpiresAt]);

  // Trocar de conversa invalida a geração em voo: sucesso ou erro atrasado da
  // conversa anterior nunca tocam o composer atual. Layout, não passivo: invalida
  // no próprio commit da troca, sem janela até a limpeza passiva.
  useLayoutEffect(() => () => {
    copilotRequestRef.current = null;
    setSuggestion(null);
    setGenerating(false);
  }, [conversationId]);

  useEffect(() => {
    if (!attachment) {
      setPreviewUrl("");
      return;
    }
    const url = URL.createObjectURL(attachment.file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment]);

  useEffect(() => () => {
    discardRecordingRef.current = true;
    if (mediaRecorderRef.current?.state !== "inactive") mediaRecorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (recordingTimerRef.current !== null) window.clearInterval(recordingTimerRef.current);
  }, []);

  function clearRecordingResources() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    if (recordingTimerRef.current !== null) window.clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;
    setRecording(false);
  }

  function selectFile(file: globalThis.File) {
    const mediaType = attachmentType(file);
    if (!supports(mediaType)) return onError(`${MEDIA_LABELS[mediaType]} não é suportado por este canal`);
    const limit = MAX_BYTES[mediaType];
    if (!file.size) return onError("O arquivo selecionado está vazio");
    if (file.size > limit) return onError(`O limite para este anexo é ${Math.round(limit / 1024 / 1024)} MB`);
    onError("");
    setAttachment({ file, mediaType });
    if (mediaType === "audio") setDraft("");
  }

  // Colar imagem (CTRL+V) entra no mesmo fluxo do anexo por seleção:
  // validação → prévia → confirmação no Enviar. Nunca envia direto no paste.
  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!canSend) return;
    const file = Array.from(event.clipboardData?.files ?? []).find((candidate) => candidate.type.startsWith("image/"));
    if (!file) return;
    event.preventDefault();
    if (!supports("image")) return onError("Imagem não é suportada por este canal");
    selectFile(file);
  }

  async function startRecording() {
    if (!supports("audio")) return onError("Áudio não é suportado por este canal");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      return onError("Este navegador não oferece gravação de áudio");
    }
    try {
      onError("");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferredMimeType = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/webm"]
        .find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, preferredMimeType ? { mimeType: preferredMimeType } : undefined);
      streamRef.current = stream;
      mediaRecorderRef.current = recorder;
      discardRecordingRef.current = false;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const chunks = chunksRef.current;
        const mimeType = recorder.mimeType || preferredMimeType || "audio/webm";
        clearRecordingResources();
        if (discardRecordingRef.current || !chunks.length) return;
        const extension = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "m4a" : "webm";
        const file = new globalThis.File(chunks, `audio-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`, { type: mimeType });
        selectFile(file);
      };
      recorder.start(250);
      setAttachment(null);
      setRecordingSeconds(0);
      setRecording(true);
      recordingTimerRef.current = window.setInterval(() => setRecordingSeconds((current) => current + 1), 1_000);
    } catch (error) {
      clearRecordingResources();
      onError(error instanceof DOMException && error.name === "NotAllowedError"
        ? "Permita o acesso ao microfone para gravar um áudio"
        : "Não foi possível iniciar a gravação");
    }
  }

  function stopRecording(discard = false) {
    discardRecordingRef.current = discard;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (recording || !canSend || (!text && !attachment)) return;
    if (attachment && !supports(attachment.mediaType)) return onError(`${MEDIA_LABELS[attachment.mediaType]} não é suportado por este canal`);
    if (text && !canSendText) return onError("Texto não é suportado por este canal");
    const signature = `${conversationId}:${text}:${attachment?.mediaType ?? "text"}:${attachment?.file.name ?? ""}:${attachment?.file.size ?? 0}:${attachment?.file.lastModified ?? 0}:${replyTo?.id ?? ""}`;
    const previous = sendAttemptRef.current;
    let attempt = previous?.signature === signature ? previous : { signature, key: randomUUID() };
    sendAttemptRef.current = attempt;
    setSending(true);
    onError("");
    try {
      const body = attachment ? {
        mediaType: attachment.mediaType,
        mimeType: attachment.file.type || "application/octet-stream",
        fileName: attachment.file.name,
        dataBase64: await fileBase64(attachment.file),
        ...(text ? { caption: text } : {}),
        ...(replyTo ? { replyToMessageId: replyTo.id } : {})
      } : { text, ...(replyTo ? { replyToMessageId: replyTo.id } : {}) };
      const post = (key: string) => api(`/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: JSON.stringify(body)
      });
      try {
        await post(attempt.key);
      } catch (error) {
        if (!confirmedFailedSend(error)) throw error;
        attempt = { signature, key: randomUUID() };
        sendAttemptRef.current = attempt;
        await post(attempt.key);
      }
      sendAttemptRef.current = null;
      setDraft("");
      setAttachment(null);
      onCancelReply?.();
      await onSent();
    } catch (error) {
      if (definitiveProviderRejection(error)) sendAttemptRef.current = null;
      onError(error instanceof Error ? error.message : "Falha ao enviar a mensagem");
    } finally {
      setSending(false);
    }
  }

  // Copiloto (SPEC R3): gera só no clique; a sugestão fica num chip à parte e
  // só entra no rascunho quando o operador escolhe usá-la — nunca é enviada.
  async function generateSuggestion() {
    if (copilotRequestRef.current) return; // trava síncrona: clique duplo no mesmo tick
    const previous = suggestion?.suggestion.trim().slice(0, 4_000);
    const request = {};
    copilotRequestRef.current = request;
    setGenerating(true);
    onError("");
    try {
      const result = await api<Partial<CopilotSuggestion> | undefined>(`/conversations/${conversationId}/copilot-suggestion`, {
        method: "POST",
        body: JSON.stringify(previous ? { previous_suggestion: previous } : {})
      });
      // Resposta vazia ou fora do contrato (204, {}, texto em branco, sem metadados) nunca vira chip falso.
      if (typeof result?.suggestion !== "string" || !result.suggestion.trim() || typeof result.context_complete !== "boolean"
        || !Number.isFinite(result.messages_used) || !Number.isFinite(result.messages_total)) {
        throw new Error("A IA não retornou uma sugestão válida. Tente novamente.");
      }
      if (copilotRequestRef.current === request) setSuggestion(result as CopilotSuggestion);
    } catch (error) {
      if (copilotRequestRef.current === request) onError(error instanceof Error ? error.message : "Falha ao gerar a sugestão da IA");
    } finally {
      if (copilotRequestRef.current === request) {
        copilotRequestRef.current = null;
        setGenerating(false);
      }
    }
  }

  function applySuggestion() {
    if (!suggestion) return;
    if (draft.trim() && !window.confirm("Substituir o rascunho atual pela sugestão da IA?")) return;
    setDraft(suggestion.suggestion);
    textareaRef.current?.focus();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // O popup de respostas rápidas intercepta Enter/Tab/setas ANTES do
    // submit-guard: Enter seleciona e insere, nunca envia (preventDefault +
    // stopPropagation dentro do popup — inclusive contra o guard do IME).
    if (quickRepliesRef.current?.handleKeyDown(event)) return;
    const compositionJustEnded = compositionJustEndedRef.current;
    compositionJustEndedRef.current = false;
    if (!shouldSubmitOnEnter({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.nativeEvent.keyCode,
      compositionActive: compositionActiveRef.current,
      compositionJustEnded
    })) return;
    event.preventDefault();
    // Safari < 16 não tem requestSubmit ("a.requestSubmit is not a function"):
    // submitForm cobre o caminho nativo e o fallback legado.
    submitForm(formRef.current);
  }

  return (
    <form
      ref={formRef}
      onSubmit={send}
      className="conversation-composer shrink-0"
      aria-busy={sending}
      data-draft={draft.trim() ? "true" : "false"}
      data-mode="reply"
    >
      <div className="conversation-composer__tabs" role="tablist" aria-label="Tipo de mensagem">
        <span className="is-active" role="tab" aria-selected="true">Responder</span>
        <span role="tab" aria-selected="false" aria-disabled="true">Nota interna</span>
      </div>
      {replyTo ? (
        <div className="composer-reply-chip mb-3">
          <span className="min-w-0 flex-1">
            <strong>
              <ArrowBendUpLeft size={11} className="mr-1 inline" aria-hidden="true" />
              {replyTo.sender === "contact" ? "Contato" : replyTo.sender === "agent" ? "IA" : "Você"}
            </strong>
            <span className="line-clamp-2">{replyTo.content}</span>
          </span>
          <Button type="button" onClick={onCancelReply} className="btn shrink-0 p-1.5" aria-label="Cancelar resposta" disabled={sending}>
            <X size={14} />
          </Button>
        </div>
      ) : null}
      {suggestion ? (
        <div className="composer-reply-chip mb-3" role="group" aria-label="Sugestão da IA">
          <span className="min-w-0 flex-1">
            <strong>
              <MagicWand size={11} className="mr-1 inline" aria-hidden="true" />
              Sugestão da IA
            </strong>
            <span className="line-clamp-2" title={suggestion.suggestion}>{suggestion.suggestion}</span>
            {!suggestion.context_complete ? (
              <span className="block text-xs text-[var(--warning-text)]">
                {`Histórico parcial: a sugestão considerou as ${suggestion.messages_used} mensagens mais recentes de ${suggestion.messages_total}.`}
              </span>
            ) : null}
          </span>
          <Button type="button" onClick={applySuggestion} className="btn shrink-0 p-1.5" aria-label="Usar sugestão" disabled={draftLocked}>
            <Check size={14} />
          </Button>
          <Button type="button" onClick={() => setSuggestion(null)} className="btn shrink-0 p-1.5" aria-label="Descartar sugestão">
            <X size={14} />
          </Button>
        </div>
      ) : null}
      {attachment ? (
        <div className="mb-3 flex items-center gap-3 rounded-md border border-[var(--border)] px-3 py-2.5">
          {attachment.mediaType === "image" && previewUrl ? (
            <>
              {/* Blob previews are local, short-lived URLs and cannot be handled by the Next image optimizer. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl} alt="Prévia do anexo" className="h-14 w-14 rounded-lg object-cover" />
            </>
          ) : null}
          {attachment.mediaType === "audio" && previewUrl ? (
            <VoiceMessagePlayer src={previewUrl} label={audioDisplayName(attachment.file.name)} />
          ) : null}
          {attachment.mediaType === "video" && previewUrl ? (
            <video src={previewUrl} controls preload="metadata" className="h-14 max-w-28 rounded-lg object-cover" aria-label={`Prévia de ${attachment.file.name}`} />
          ) : null}
          {attachment.mediaType === "document" ? <File size={24} className="shrink-0 text-[var(--primary-text)]" /> : null}
          <div className={attachment.mediaType === "audio" ? "w-28 min-w-0 shrink-0" : "min-w-0 flex-1"}>
            <strong className="block truncate text-xs text-[var(--text)]">
              {attachment.mediaType === "audio" ? audioDisplayName(attachment.file.name) : attachment.file.name}
            </strong>
            <span className="mono mt-1 block text-xs uppercase tracking-wide text-[var(--text-muted)]">{attachment.mediaType} · {formatBytes(attachment.file.size)}</span>
          </div>
          <Button type="button" onClick={() => setAttachment(null)} className="btn p-2 active:scale-95" aria-label="Remover anexo" disabled={sending}>
            <X size={16} />
          </Button>
        </div>
      ) : null}

      {recording ? (
        <VoiceInput
          stream={streamRef.current}
          elapsedSeconds={recordingSeconds}
          onCancel={() => stopRecording(true)}
          onStop={() => stopRecording()}
        />
      ) : null}

      <div className={styles.anchor}>
        {canSendText ? (
          <ConversationQuickReplies
            conversationId={conversationId}
            contactName={contactName}
            draft={draft}
            onReplaceDraft={setDraft}
            textareaRef={textareaRef}
            controlRef={quickRepliesRef}
          />
        ) : null}
        {/* DS v2 (Conversas.dc.html): textarea de largura total sem caixa própria;
            abaixo, uma linha só — anexar, áudio, respostas rápidas e envio. */}
        <div className="conversation-composer__controls">
        <Input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          tabIndex={-1}
          aria-label="Selecionar arquivo para anexar"
          accept={acceptedFiles}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) selectFile(file);
            event.target.value = "";
          }}
        />
        <label className="conversation-composer__field">
          <span className="sr-only">Mensagem</span>
          <Textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            onPaste={handlePaste}
            onCompositionStart={() => { compositionActiveRef.current = true; }}
            onCompositionEnd={() => {
              compositionActiveRef.current = false;
              // Safari: o keydown do Enter que confirma a composição vem DEPOIS
              // deste evento, com isComposing=false — não pode enviar.
              compositionJustEndedRef.current = true;
            }}
            className="conversation-composer__textarea input max-h-32"
            placeholder={attachment?.mediaType === "audio" ? "Áudio pronto para enviar" : attachment ? "Adicionar uma legenda" : channel === "instagram" ? "Responder pelo Instagram" : "Responder pelo WhatsApp conectado"}
            autoComplete="off"
            disabled={draftLocked}
          />
        </label>
        <div className="conversation-composer__actions">
        <Button type="button" className="conversation-composer__tool active:scale-95" onClick={() => fileInputRef.current?.click()} aria-label="Anexar arquivo" disabled={sending || recording || !canAttach}>
          <Paperclip size={16} aria-hidden="true" />
        </Button>
        <Button type="button" className="conversation-composer__tool active:scale-95" onClick={startRecording} aria-label="Gravar áudio" disabled={sending || recording || !supports("audio")}>
          <Microphone size={16} aria-hidden="true" />
        </Button>
        <Tooltip content="Gera uma resposta sugerida pela IA com base na conversa. A sugestão entra no rascunho só quando você confirma.">
          <Button type="button" className="conversation-composer__tool active:scale-95" onClick={generateSuggestion} aria-label={generating ? "Gerando sugestão da IA" : suggestion ? "Gerar outra sugestão da IA" : "Gerar sugestão da IA"} disabled={generating}>
            {generating ? <span className="on-spinner" aria-hidden="true" /> : <MagicWand size={16} aria-hidden="true" />}
          </Button>
        </Tooltip>
          <div className="conversation-composer__quick-replies" role="group" aria-label="Respostas rápidas" tabIndex={0}>
            <HelpHint label="Ajuda: Respostas rápidas" title="Respostas rápidas">
              Digite <kbd>/</kbd> no começo da mensagem para abrir a lista de respostas rápidas. A escolhida substitui o atalho e variáveis como {"{{nome}}"} e {"{{data}}"} são preenchidas na inserção.
            </HelpHint>
            <span className="chip-action">Enviar proposta</span>
            <span className="chip-action">Confirmar horário</span>
            <span className="chip-action">Pedir CNPJ</span>
          </div>
        {/* DS v2: envio circular de 32px (ref. Conversas.dc.html). O nome
            acessível "Enviar mensagem"/"Enviando mensagem" não muda; sem
            rascunho fica neutro, com rascunho ciano cheio com glow. */}
        <Button
          type="submit"
          className="conversation-composer__send btn"
          data-ready={draft.trim() || attachment ? "true" : undefined}
          aria-label={sending ? "Enviando mensagem" : "Enviar mensagem"}
          disabled={sending || recording || !canSend || (!draft.trim() && !attachment)}
        >
          {sending ? <span className="on-spinner" aria-hidden="true" /> : <PaperPlaneRight size={16} aria-hidden="true" />}
        </Button>
        </div>
        </div>
      </div>
      {availabilityMessage ? <p className="mt-2 text-xs text-[var(--warning-text)]" role="status">{availabilityMessage}</p> : null}
      <p className="conversation-composer__hint mono">Enter envia · Shift + Enter quebra a linha</p>
    </form>
  );
}
