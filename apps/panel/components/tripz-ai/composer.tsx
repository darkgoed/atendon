"use client";

import { FilePdf, Image as ImageIcon, Paperclip, PaperPlaneTilt, SpinnerGap, X } from "@phosphor-icons/react";
import {
  default as React,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import {
  deleteTripzAttachment,
  createTripzIdempotencyKey,
  formatTripzFileSize,
  sendTripzMessage,
  shouldSubmitTripzComposer,
  TRIPZ_AI_ACCEPT,
  TRIPZ_AI_MAX_FILES_PER_MESSAGE,
  uploadTripzAttachment,
  validateTripzFiles,
  type TripzAttachment,
  type TripzSendResult
} from "../../lib/tripz-ai";

import styles from "./tripz-ai.module.css";

type ComposerFileStatus = "ready" | "uploading" | "uploaded" | "error";

type ComposerFile = {
  localId: string;
  file: File;
  previewUrl?: string;
  status: ComposerFileStatus;
  attachment?: TripzAttachment;
  error?: string;
};

export function disposeTripzComposerFiles(
  conversationId: string,
  items: readonly { previewUrl?: string; attachment?: Pick<TripzAttachment, "id"> }[],
  removeAttachment: (targetConversationId: string, attachmentId: string) => Promise<void> = deleteTripzAttachment,
  revokePreview: (url: string) => void = (url) => URL.revokeObjectURL(url)
): void {
  items.forEach((item) => {
    if (item.previewUrl) revokePreview(item.previewUrl);
    if (item.attachment) void removeAttachment(conversationId, item.attachment.id).catch(() => undefined);
  });
}

function localFileId(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`;
}

function fileFingerprint(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}:${file.type}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Upload cancelado.";
  return error instanceof Error ? error.message : "Não foi possível enviar o arquivo.";
}

export function TripzComposer({
  conversationId,
  disabled = false,
  processing = false,
  onSent
}: {
  conversationId: string;
  disabled?: boolean;
  processing?: boolean;
  onSent: (result: TripzSendResult) => void | Promise<void>;
}) {
  const [text, setText] = useState("");
  const [items, setItems] = useState<ComposerFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const itemsRef = useRef(items);
  const controllersRef = useRef(new Map<string, AbortController>());
  const sendAttemptRef = useRef<{ fingerprint: string; key: string } | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const commitItems = useCallback((updater: (current: ComposerFile[]) => ComposerFile[]) => {
    setItems((current) => {
      const next = updater(current);
      itemsRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => () => {
    const abandoned = itemsRef.current;
    itemsRef.current = [];
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
    disposeTripzComposerFiles(conversationId, abandoned);
  }, [conversationId]);

  const addFiles = useCallback((files: readonly File[]) => {
    setError("");
    const current = itemsRef.current;
    const fingerprints = new Set(current.map(({ file }) => fileFingerprint(file)));
    const unique = files.filter((file) => {
      const fingerprint = fileFingerprint(file);
      if (fingerprints.has(fingerprint)) return false;
      fingerprints.add(fingerprint);
      return true;
    });
    const duplicateCount = files.length - unique.length;
    const { accepted, rejected } = validateTripzFiles(
      unique,
      TRIPZ_AI_MAX_FILES_PER_MESSAGE - current.length,
      current.reduce((total, item) => total + item.file.size, 0)
    );
    const nextItems = accepted.map<ComposerFile>((file) => ({
      localId: localFileId(file),
      file,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      status: "ready"
    }));
    if (nextItems.length) commitItems((value) => [...value, ...nextItems]);
    const notices = [
      duplicateCount ? `${duplicateCount} arquivo(s) repetido(s) ignorado(s).` : "",
      ...rejected.map(({ file, reason }) => `${file.name}: ${reason}`)
    ].filter(Boolean);
    if (notices.length) setError(notices.join(" "));
  }, [commitItems]);

  const removeItem = useCallback((localId: string) => {
    const item = itemsRef.current.find((candidate) => candidate.localId === localId);
    if (!item) return;
    controllersRef.current.get(localId)?.abort();
    controllersRef.current.delete(localId);
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    commitItems((current) => current.filter((candidate) => candidate.localId !== localId));
    if (item.attachment) {
      void deleteTripzAttachment(conversationId, item.attachment.id).catch(() => undefined);
    }
  }, [commitItems, conversationId]);

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  };

  const clearAfterSend = useCallback(() => {
    itemsRef.current.forEach((item) => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
    itemsRef.current = [];
    setItems([]);
    setText("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const uploadItem = useCallback(async (item: ComposerFile): Promise<TripzAttachment> => {
    if (item.attachment) return item.attachment;
    const controller = new AbortController();
    controllersRef.current.set(item.localId, controller);
    commitItems((current) => current.map((candidate) => candidate.localId === item.localId
      ? { ...candidate, status: "uploading", error: undefined }
      : candidate));
    try {
      const attachment = await uploadTripzAttachment(conversationId, item.file, controller.signal);
      if (!itemsRef.current.some((candidate) => candidate.localId === item.localId)) {
        await deleteTripzAttachment(conversationId, attachment.id).catch(() => undefined);
        throw new DOMException("Upload cancelado", "AbortError");
      }
      commitItems((current) => current.map((candidate) => candidate.localId === item.localId
        ? { ...candidate, attachment, status: "uploaded", error: undefined }
        : candidate));
      return attachment;
    } catch (uploadError) {
      if (itemsRef.current.some((candidate) => candidate.localId === item.localId)) {
        commitItems((current) => current.map((candidate) => candidate.localId === item.localId
          ? { ...candidate, status: "error", error: errorMessage(uploadError) }
          : candidate));
      }
      throw uploadError;
    } finally {
      controllersRef.current.delete(item.localId);
    }
  }, [commitItems, conversationId]);

  const submit = useCallback(async () => {
    const content = text.trim();
    const snapshot = itemsRef.current;
    if (disabled || processing || submitting || (!content && snapshot.length === 0)) return;
    setSubmitting(true);
    setError("");
    try {
      const uploads = await Promise.allSettled(snapshot.map((item) => uploadItem(item)));
      const firstFailure = uploads.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (firstFailure) throw firstFailure.reason;
      const uploadedAttachments = uploads.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      if (uploadedAttachments.length !== snapshot.length) {
        throw new Error("Revise os anexos que não concluíram o upload.");
      }
      // The backend intentionally reuses an unlinked object with the same
      // content hash. Multiple local selections can therefore resolve to one
      // attachment id without representing a failed upload.
      const attachmentIds = [...new Set(uploadedAttachments.map((attachment) => attachment.id))];
      const fingerprint = JSON.stringify({ content, attachmentIds });
      if (sendAttemptRef.current?.fingerprint !== fingerprint) {
        sendAttemptRef.current = { fingerprint, key: createTripzIdempotencyKey("message") };
      }
      const result = await sendTripzMessage(conversationId, {
        content,
        attachmentIds,
        idempotencyKey: sendAttemptRef.current.key
      });
      sendAttemptRef.current = undefined;
      clearAfterSend();
      await onSent(result);
      requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }, [clearAfterSend, conversationId, disabled, onSent, processing, submitting, text, uploadItem]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!shouldSubmitTripzComposer({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing
    })) return;
    event.preventDefault();
    void submit();
  };

  const unavailable = disabled || processing;
  const canSend = !unavailable && !submitting && Boolean(text.trim() || items.length);

  return (
    <div
      className={`${styles.composer} ${dragging ? styles.composerDragging : ""}`}
      onDragEnter={(event) => { event.preventDefault(); if (!unavailable) setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={handleDrop}
    >
      {dragging ? (
        <div className="pointer-events-none absolute inset-2 grid place-items-center border border-dashed tripz-border-primary tripz-bg-bg text-xs font-semibold tripz-text-primary" role="status">
          Solte imagens ou PDFs para anexar
        </div>
      ) : null}

      <div className="mx-auto grid w-full max-w-[52rem] gap-2">
        {items.length > 0 ? (
          <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Anexos preparados">
            {items.map((item) => {
              const isPdf = item.file.type === "application/pdf";
              return (
                <article key={item.localId} className="grid w-[13.5rem] shrink-0 grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-2 border tripz-border-border tripz-bg-surface p-2">
                  <span className="grid h-11 w-11 place-items-center overflow-hidden border tripz-border-border tripz-bg-surface_elevated tripz-text-primary">
                    {item.previewUrl ? (
                      // Blob local criado pelo próprio navegador para a prévia antes do upload.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.previewUrl} className="h-full w-full object-cover" alt="" />
                    ) : isPdf ? <FilePdf size={20} weight="duotone" aria-hidden="true" /> : <ImageIcon size={20} aria-hidden="true" />}
                  </span>
                  <span className="grid min-w-0 gap-0.5">
                    <strong className="truncate text-[11px] font-semibold tripz-text-text">{item.file.name}</strong>
                    <span className={`truncate text-[9px] ${item.status === "error" ? "tripz-text-warning" : "tripz-text-text_muted"}`}>
                      {item.status === "uploading" ? "Enviando…" : item.status === "uploaded" ? "Pronto" : item.error ?? formatTripzFileSize(item.file.size)}
                    </span>
                  </span>
                  <button type="button" className="grid h-7 w-7 place-items-center tripz-bg-transparent tripz-text-text_muted transition-[background,transform] hover:tripz-bg-warning_subtle hover:tripz-text-warning active:scale-[.96]" onClick={() => removeItem(item.localId)} aria-label={`Remover ${item.file.name}`}>
                    {item.status === "uploading" ? <SpinnerGap size={13} className="animate-spin" aria-hidden="true" /> : <X size={13} aria-hidden="true" />}
                  </button>
                </article>
              );
            })}
          </div>
        ) : null}

        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-2 border tripz-border-border_strong tripz-bg-surface p-2 focus-within:tripz-border-primary focus-within:shadow-[var(--focus-ring)]">
          <input ref={fileInputRef} type="file" className="sr-only" accept={TRIPZ_AI_ACCEPT} multiple onChange={handleFileInput} disabled={unavailable || submitting || items.length >= TRIPZ_AI_MAX_FILES_PER_MESSAGE} aria-label="Anexar imagens ou PDF" aria-describedby="tripz-composer-help" />
          <button type="button" className="grid h-10 w-10 place-items-center tripz-bg-transparent tripz-text-text_secondary transition-[background,transform] hover:tripz-bg-surface_active hover:tripz-text-text active:translate-y-px disabled:opacity-40" onClick={() => fileInputRef.current?.click()} disabled={unavailable || submitting || items.length >= TRIPZ_AI_MAX_FILES_PER_MESSAGE} aria-label="Anexar imagens ou PDF" title="Anexar imagens ou PDF">
            <Paperclip size={19} aria-hidden="true" />
          </button>
          <label className="sr-only" htmlFor="tripz-message">Envie informações da viagem</label>
          <textarea
            ref={textareaRef}
            id="tripz-message"
            className="max-h-36 min-h-10 w-full resize-none border-0 tripz-bg-transparent px-1 py-2 text-[13px] leading-5 tripz-text-text outline-none placeholder:tripz-text-text_muted disabled:opacity-60"
            rows={1}
            maxLength={12_000}
            value={text}
            disabled={unavailable || submitting}
            placeholder={processing ? "Aguarde a análise atual…" : "Envie informações da viagem…"}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            aria-describedby="tripz-composer-help tripz-composer-error"
          />
          <button
            type="button"
            className="grid h-10 w-10 place-items-center border tripz-border-primary tripz-bg-primary tripz-text-primary_fg transition-[transform,opacity] hover:opacity-90 active:translate-y-px disabled:tripz-border-border disabled:tripz-bg-surface_elevated disabled:tripz-text-text_muted disabled:opacity-60"
            disabled={!canSend}
            onClick={() => void submit()}
            aria-label={submitting ? "Enviando mensagem" : "Enviar mensagem"}
          >
            {submitting ? <SpinnerGap size={17} className="animate-spin" aria-hidden="true" /> : <PaperPlaneTilt size={17} weight="fill" aria-hidden="true" />}
          </button>
        </div>

        <div className="flex min-h-4 items-start justify-between gap-4 px-1 text-[9px] leading-4 tripz-text-text_muted">
          <p id="tripz-composer-help" className="m-0">Enter envia · Shift+Enter quebra linha · cole ou arraste até 10 arquivos</p>
          <span className="shrink-0 font-mono">{text.length.toLocaleString("pt-BR")}/12.000</span>
        </div>
        <p id="tripz-composer-error" className={`m-0 min-h-0 text-[10px] leading-4 tripz-text-warning ${error ? "block" : "hidden"}`} role="alert">{error}</p>
      </div>
    </div>
  );
}
