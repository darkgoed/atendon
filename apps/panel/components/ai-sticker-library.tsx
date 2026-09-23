"use client";

import { Check, FloppyDisk, Sticker, Trash, UploadSimple, WhatsappLogo } from "@/components/icons";
import { FormEvent, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { api } from "@/lib/api";
import { SaveButton, SaveToast, useSaveFeedback } from "@/components/ui";
import { IconButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorState, LoadingState } from "@/components/ui/status";


type AiSticker = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  mime_type: string;
  file_name: string;
  size_bytes: number;
  source: "panel_upload" | "whatsapp_sent";
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

type StickerDraft = Pick<AiSticker, "name" | "description" | "tags" | "enabled">;

const fetcher = <T,>(url: string) => api<T>(url);

function contentUrl(id: string) {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/backend";
  return `${base}/ai-stickers/${id}/content`;
}

function formatSize(bytes: number) {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Não foi possível ler o arquivo"));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}

export function AiStickerLibrary() {
  const { data, error, isLoading, mutate } = useSWR<{ stickers: AiSticker[] }>("/ai-stickers", fetcher, { revalidateOnFocus: false });
  const [drafts, setDrafts] = useState<Record<string, StickerDraft>>({});
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [file, setFile] = useState<File>();
  const [status, setStatus] = useState("");
  const [busyId, setBusyId] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const saveState = useSaveFeedback();
  const uploadSave = useSaveFeedback();
  const fileInput = useRef<HTMLInputElement>(null);
  const stickers = useMemo(() => data?.stickers ?? [], [data?.stickers]);
  const pendingCount = useMemo(() => stickers.filter((sticker) => !sticker.enabled).length, [stickers]);

  const draftFor = (sticker: AiSticker): StickerDraft => drafts[sticker.id] ?? {
    name: sticker.name,
    description: sticker.description,
    tags: sticker.tags,
    enabled: sticker.enabled
  };
  const changeDraft = (sticker: AiSticker, patch: Partial<StickerDraft>) => {
    setDrafts((current) => ({ ...current, [sticker.id]: { ...draftFor(sticker), ...patch } }));
  };

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) return setStatus("Selecione uma figurinha WebP.");
    if (file.type !== "image/webp" && !file.name.toLocaleLowerCase("pt-BR").endsWith(".webp")) return setStatus("Use um arquivo WebP.");
    if (file.size > 1024 * 1024) return setStatus("A figurinha deve ter no máximo 1 MB.");
    setUploading(true);
    try {
      await api("/ai-stickers", {
        method: "POST",
        body: JSON.stringify({
          name,
          description,
          tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
          fileName: file.name,
          mimeType: "image/webp",
          dataBase64: await fileBase64(file)
        })
      });
      setName("");
      setDescription("");
      setTags("");
      setFile(undefined);
      if (fileInput.current) fileInput.current.value = "";
      setStatus("Figurinha adicionada à biblioteca.");
      uploadSave.markDone();
      await mutate();
    } catch (uploadError) {
      setStatus(uploadError instanceof Error ? uploadError.message : "Não foi possível enviar a figurinha.");
    } finally {
      setUploading(false);
    }
  }

  async function save(sticker: AiSticker) {
    const draft = draftFor(sticker);
    setBusyId(sticker.id);
    setStatus("");
    try {
      await api(`/ai-stickers/${sticker.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...draft, tags: draft.tags.map((tag) => tag.trim()).filter(Boolean) })
      });
      setDrafts((current) => {
        const next = { ...current };
        delete next[sticker.id];
        return next;
      });
      setStatus("Biblioteca atualizada.");
      saveState.markDone();
      await mutate();
    } catch (saveError) {
      setStatus(saveError instanceof Error ? saveError.message : "Não foi possível salvar.");
    } finally {
      setBusyId(undefined);
    }
  }

  async function remove(sticker: AiSticker) {
    if (!window.confirm(`Remover “${sticker.name}” da biblioteca?`)) return;
    setBusyId(sticker.id);
    try {
      await api(`/ai-stickers/${sticker.id}`, { method: "DELETE" });
      setStatus("Figurinha removida.");
      await mutate();
    } catch (removeError) {
      setStatus(removeError instanceof Error ? removeError.message : "Não foi possível remover.");
    } finally {
      setBusyId(undefined);
    }
  }

  return <>
    <header className="pagehead items-start">
      <div>
        <div className="mb-3 flex items-center gap-2 text-[var(--primary-text)]"><Sticker size={18}/><span className="mono type-caption uppercase tracking-[.16em]">Biblioteca da IA</span></div>
        <h1>Figurinhas com contexto</h1>
        <p>A IA escolhe somente itens ativos e usa sua descrição para entender o momento certo.</p>
      </div>
      <div className="mono border-l border-[var(--border)] pl-5 text-right type-caption uppercase tracking-[.12em] text-[var(--text-muted)]">
        <strong className="block text-2xl font-semibold text-[var(--text)]">{stickers.length}</strong>
        {pendingCount} aguardando revisão
      </div>
    </header>

    <div className="channels-ai-grid xl:grid-cols-[minmax(0,1.45fr)_minmax(300px,.55fr)]">
      <section className="channels-ai-min-zero">
        <div className="mb-5 flex items-end justify-between border-b border-[var(--border)] pb-3">
          <div><h2 className="text-base font-semibold">Biblioteca</h2><p className="sub mt-1">Desative uma figurinha para impedir novos envios sem apagá-la.</p></div>
        </div>
        {isLoading ? <LoadingState label="Carregando figurinhas" />
          : error ? <ErrorState>{error.message}</ErrorState>
          : stickers.length === 0 ? <Card className="channels-ai-section channels-ai-section--flat channels-ai-empty flex flex-col items-start justify-center py-12">
              <Sticker size={38} className="mb-5 text-[var(--text-muted)]"/><h2 className="text-lg font-semibold">Nenhuma figurinha cadastrada</h2><p className="sub mt-2 max-w-lg">Envie um WebP pelo formulário ou mande uma figurinha pelo WhatsApp conectado para iniciar a biblioteca.</p>
            </Card>
          : <div className="channels-ai-list">
            {stickers.map((sticker) => {
              const draft = draftFor(sticker);
              const dirty = JSON.stringify(draft) !== JSON.stringify({ name: sticker.name, description: sticker.description, tags: sticker.tags, enabled: sticker.enabled });
              return <article key={sticker.id} className="channels-ai-list-item md:grid-cols-[7.25rem_minmax(0,1fr)_auto]">
                <div className="channels-ai-sticker-preview">
                  {/* Authenticated media is intentionally rendered directly; the Next image optimizer cannot forward the session cookie. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={contentUrl(sticker.id)} alt={`Prévia de ${sticker.name}`} className="max-h-full max-w-full object-contain" loading="lazy"/>
                </div>
                <div className="grid channels-ai-min-zero gap-3 sm:grid-cols-2">
                  <label className="field"><span>Nome</span><input className="input" value={draft.name} onChange={(event) => changeDraft(sticker, { name: event.target.value })}/></label>
                  <label className="field"><span>Tags separadas por vírgula</span><input className="input" value={draft.tags.join(", ")} onChange={(event) => changeDraft(sticker, { tags: event.target.value.split(",") })}/></label>
                  <label className="field sm:col-span-2"><span>Quando a IA pode usar</span><textarea className="input channels-ai-textarea-compact resize-y" placeholder="Ex.: comemorar quando o cliente confirma o agendamento" value={draft.description} onChange={(event) => changeDraft(sticker, { description: event.target.value })}/></label>
                  <div className="sm:col-span-2 flex flex-wrap items-center gap-3 type-caption text-[var(--text-muted)]">
                    <span className="mono uppercase tracking-[.1em]">{sticker.source === "whatsapp_sent" ? "Importada do WhatsApp" : "Enviada pelo painel"}</span><span>{formatSize(sticker.size_bytes)}</span>
                    <label className="ml-auto flex items-center gap-2 text-xs text-[var(--text-secondary)]"><input type="checkbox" checked={draft.enabled} onChange={(event) => changeDraft(sticker, { enabled: event.target.checked })}/>Disponível para a IA</label>
                  </div>
                </div>
                <div className="flex items-start gap-2 md:flex-col">
                  <SaveButton
                    type="button"
                    className="channels-ai-touch"
                    state={busyId === sticker.id ? "busy" : "idle"}
                    icon={<FloppyDisk size={15} aria-hidden="true" />}
                    disabled={!dirty}
                    onClick={() => void save(sticker)}
                  >
                    Salvar
                  </SaveButton>
                  <IconButton className="channels-ai-touch" label={`Remover ${sticker.name}`} disabled={busyId === sticker.id} onClick={() => void remove(sticker)}><Trash size={15} aria-hidden="true" /></IconButton>
                </div>
              </article>;
            })}
          </div>}
      </section>

      <aside className="grid content-start gap-7">
        <form onSubmit={upload} className="grid gap-4 border-t border-[var(--border)] pt-5">
          <div><h2 className="flex items-center gap-2 text-base font-semibold"><UploadSimple size={17}/>Adicionar arquivo</h2><p className="sub mt-1">WebP de até 1 MB.</p></div>
          <label className="field"><span>Arquivo</span><input ref={fileInput} className="input file:mr-3 file:border-0 file:bg-transparent file:text-xs file:font-semibold" type="file" accept="image/webp,.webp" onChange={(event) => setFile(event.target.files?.[0])}/></label>
          <label className="field"><span>Nome</span><input className="input" required minLength={2} maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="Confirmação animada"/></label>
          <label className="field"><span>Quando usar</span><textarea className="input channels-ai-textarea-tall resize-y" required minLength={3} maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Ex.: quando o contato demonstrar entusiasmo depois de confirmar uma visita"/></label>
          <label className="field"><span>Tags</span><input className="input" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="confirmação, comemoração"/><small className="sub">Separe por vírgula.</small></label>
          <SaveButton
            type="submit"
            className="channels-ai-touch"
            state={uploading ? "busy" : uploadSave.state}
            busyLabel="Enviando figurinha…"
            doneLabel="Adicionada"
            icon={<UploadSimple size={16} aria-hidden="true" />}
            disabled={!file || !name.trim() || !description.trim()}
          >
            Adicionar à biblioteca
          </SaveButton>
          <SaveToast show={uploadSave.done}>Figurinha adicionada</SaveToast>
        </form>

        <section className="border-t border-[var(--border)] pt-5">
          <div className="mb-3 flex items-center gap-2"><WhatsappLogo size={18} className="text-[var(--primary-text)]"/><h2 className="text-base font-semibold">Trazer uma favorita</h2></div>
          <ol className="grid gap-3 text-sm leading-relaxed text-[var(--text-secondary)]">
            <li className="flex gap-3"><span className="mono text-[var(--primary-text)]">01</span><span>Abra o WhatsApp conectado ao AtendON.</span></li>
            <li className="flex gap-3"><span className="mono text-[var(--primary-text)]">02</span><span>Envie a figurinha favorita em uma conversa individual.</span></li>
            <li className="flex gap-3"><span className="mono text-[var(--primary-text)]">03</span><span>Ela aparecerá aqui desativada. Descreva o uso e salve para liberar à IA.</span></li>
          </ol>
          <p className="sub mt-4">O WhatsApp não disponibiliza a lista de favoritas para sincronização direta; o envio único permite importar o arquivo com segurança.</p>
        </section>
        {status ? <p role={/adicionada|atualizada|removida/.test(status) ? "status" : "alert"} className={`flex items-center gap-2 text-sm ${/adicionada|atualizada|removida/.test(status) ? "accent" : "error"}`}>{/adicionada|atualizada|removida/.test(status) ? <Check size={16} aria-hidden="true" /> : null}{status}</p> : null}
      </aside>
      <SaveToast show={saveState.done}>Figurinha salva</SaveToast>
    </div>
  </>;
}
