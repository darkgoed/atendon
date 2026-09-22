"use client";

/**
 * Editor de post do changelog (admin ROOT /root/changelog): criação e edição
 * com os contratos pousados em /root/changelog/posts (zod strict — NUNCA enviar
 * campos fora do schema: versionLabel/releaseId são proveniência display-only).
 * Mídia: multipart para /root/changelog/media + substituição do conjunto via
 * PUT /root/changelog/posts/:id/media { mediaIds } (ordem = position).
 */

import { ArrowDown, ArrowUp, FileArrowUp, Plus, Trash } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useRef, useState, type ChangeEvent } from "react";
import { Badge, Button, Dialog, Field, IconButton, Input, Select, Textarea } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import {
  CHANGELOG_CATEGORIES,
  CHANGELOG_CATEGORY_LABELS,
  changelogApiUrl,
  isChangelogVideoMime,
  type ChangelogAdminPost,
  type ChangelogMediaRecord
} from "@/lib/changelog";

const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MEDIA_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,video/mp4";

type LinkDraft = { label: string; url: string };

function parseList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function MediaRow({
  item,
  index,
  total,
  disabled,
  onReplaced,
  onMove
}: {
  item: { id: string; alt: string | null; mime: string };
  index: number;
  total: number;
  disabled: boolean;
  onReplaced: (media: ChangelogMediaRecord) => void;
  onMove: (from: number, to: number) => void;
}) {
  const [alt, setAlt] = useState(item.alt ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function saveAlt() {
    setSaving(true);
    setError("");
    try {
      const response = await api<{ media: ChangelogMediaRecord }>(`/root/changelog/media/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ alt: alt.trim() || null })
      });
      onReplaced(response.media);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível salvar a descrição.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="grid gap-2 border-y border-[var(--border)] py-3">
      <div className="flex items-start gap-3">
        <div className="w-24 shrink-0 overflow-hidden rounded-[var(--radius-sm,6px)] border border-[var(--border)]">
          {isChangelogVideoMime(item.mime) ? (
            <video src={changelogApiUrl(`/root/changelog/media/${item.id}/bytes`)} controls preload="metadata" className="max-h-20 w-full" />
          ) : (
            // Mídia autenticada servida direto pelo backend; o otimizador de
            // imagem do Next não repassa o cookie de sessão.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={changelogApiUrl(`/root/changelog/media/${item.id}/bytes`)} alt={item.alt ?? ""} className="max-h-20 w-full object-contain" loading="lazy" />
          )}
        </div>
        <div className="min-w-0 grow">
          <Field label="Descrição (alt)" hint="texto alternativo para leitores de tela">
            <Input value={alt} onChange={(event) => setAlt(event.target.value)} maxLength={300} disabled={disabled || saving} />
          </Field>
          {error ? <p className="error text-xs" role="alert">{error}</p> : null}
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          <Button size="sm" onClick={() => void saveAlt()} disabled={disabled || saving}>
            {saving ? "Salvando…" : "Salvar alt"}
          </Button>
          <div className="flex gap-1">
            <IconButton label={`Mover mídia ${index + 1} para cima`} size="sm" disabled={disabled || index === 0} onClick={() => onMove(index, index - 1)}>
              <ArrowUp size={14} aria-hidden="true" />
            </IconButton>
            <IconButton label={`Mover mídia ${index + 1} para baixo`} size="sm" disabled={disabled || index === total - 1} onClick={() => onMove(index, index + 1)}>
              <ArrowDown size={14} aria-hidden="true" />
            </IconButton>
          </div>
        </div>
      </div>
    </li>
  );
}

export function PostFormDialog({
  open,
  post,
  onClose,
  onSaved
}: {
  open: boolean;
  post: ChangelogAdminPost | null;
  onClose: () => void;
  onSaved: (post: ChangelogAdminPost) => void;
}) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [category, setCategory] = useState<string>("novo");
  const [author, setAuthor] = useState("");
  const [versionLabel, setVersionLabel] = useState("");
  const [slug, setSlug] = useState("");
  const [contentText, setContentText] = useState("");
  const [modules, setModules] = useState("");
  const [plans, setPlans] = useState("");
  const [links, setLinks] = useState<LinkDraft[]>([]);
  const [publishAt, setPublishAt] = useState("");
  const [media, setMedia] = useState<Array<{ id: string; alt: string | null; mime: string }>>([]);
  const [uploadAlt, setUploadAlt] = useState("");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const isEdit = Boolean(post);
  const lockedSlug = Boolean(post?.publishedAt);

  useEffect(() => {
    if (!open) return;
    setTitle(post?.title ?? "");
    setSummary(post?.summary ?? "");
    setCategory(post?.category ?? "novo");
    setAuthor(post?.author ?? "");
    setVersionLabel(post?.versionLabel ?? "");
    setSlug(post?.slug ?? "");
    setContentText(post?.contentText ?? "");
    setModules(post?.modulesAffected.join(", ") ?? "");
    setPlans(post?.affectedPlans.join(", ") ?? "");
    setLinks(post?.relatedLinks.length ? post.relatedLinks.map((link) => ({ ...link })) : []);
    setPublishAt("");
    setMedia(post?.media.map((item) => ({ ...item })) ?? []);
    setUploadAlt("");
    setUploading(false);
    setSaving(false);
    setError("");
    if (fileRef.current) fileRef.current.value = "";
  }, [open, post]);

  async function replaceMediaSet(ids: string[]): Promise<boolean> {
    if (!post) return false;
    try {
      const response = await api<{ media: Array<{ id: string; alt: string | null; mime: string }> }>(`/root/changelog/posts/${post.id}/media`, {
        method: "PUT",
        body: JSON.stringify({ mediaIds: ids })
      });
      setMedia(response.media);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível atualizar a mídia do post.");
      return false;
    }
  }

  async function uploadMedia() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Selecione um arquivo para enviar (PNG, JPEG, GIF, WEBP ou MP4 até 10MB).");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      if (uploadAlt.trim()) formData.append("alt", uploadAlt.trim());
      const uploaded = await api<{ media: ChangelogMediaRecord }>("/root/changelog/media", { method: "POST", body: formData });
      const attached = await replaceMediaSet([...media.map((item) => item.id), uploaded.media.id]);
      if (attached) {
        setUploadAlt("");
        if (fileRef.current) fileRef.current.value = "";
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha no upload da mídia.");
    } finally {
      setUploading(false);
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files?.length) setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle || saving) return;
    const parsedModules = parseList(modules);
    const parsedPlans = parseList(plans);
    const parsedLinks = links
      .map((link) => ({ label: link.label.trim(), url: link.url.trim() }))
      .filter((link) => link.label || link.url);
    for (const link of parsedLinks) {
      if (!link.label || !link.url) {
        setError("Preencha rótulo e URL de todos os links relacionados (ou remova a linha).");
        return;
      }
      try {
        if (new URL(link.url).protocol !== "https:") throw new Error("https");
      } catch {
        setError("Links relacionados aceitam apenas URLs https.");
        return;
      }
    }
    const trimmedSlug = slug.trim();
    if (trimmedSlug && !SLUG_SHAPE.test(trimmedSlug)) {
      setError("Slug inválido (use minúsculas, números e hífens).");
      return;
    }
    if (isEdit && post?.publishedAt && !summary.trim()) {
      setError("Post publicado exige resumo.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      if (post) {
        const body: Record<string, unknown> = {
          title: trimmedTitle,
          summary: summary.trim() || null,
          category,
          author: author.trim() || null,
          contentText: contentText.trim() || null,
          modulesAffected: parsedModules,
          affectedPlans: parsedPlans
        };
        if (parsedLinks.length) body.relatedLinks = parsedLinks;
        if (!lockedSlug && trimmedSlug && trimmedSlug !== post.slug) body.slug = trimmedSlug;
        const response = await api<{ post: ChangelogAdminPost }>(`/root/changelog/posts/${post.id}`, {
          method: "PATCH",
          body: JSON.stringify(body)
        });
        onSaved(response.post);
      } else {
        const body: Record<string, unknown> = {
          title: trimmedTitle,
          summary: summary.trim() || undefined,
          category,
          author: author.trim() || undefined,
          contentText: contentText.trim() || undefined,
          modulesAffected: parsedModules,
          affectedPlans: parsedPlans
        };
        if (trimmedSlug) body.slug = trimmedSlug;
        if (parsedLinks.length) body.relatedLinks = parsedLinks;
        if (publishAt) body.publishAt = new Date(publishAt).toISOString();
        const response = await api<{ post: ChangelogAdminPost }>("/root/changelog/posts", {
          method: "POST",
          body: JSON.stringify(body)
        });
        onSaved(response.post);
      }
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : "Não foi possível salvar o post.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={post ? "Editar post do changelog" : "Novo post do changelog"}
      description={post ? `Permalink: /changelog/${post.slug}` : "O post nasce como rascunho; publique ou agende depois de salvar."}
      size="lg"
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button tone="primary" type="submit" form="changelog-post-form" disabled={saving || !title.trim()}>
            {saving ? "Salvando…" : post ? "Salvar alterações" : "Criar post"}
          </Button>
        </>
      }
    >
      <form id="changelog-post-form" className="grid gap-3" onSubmit={submit}>
        <Field label="Título">
          <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} required placeholder="Ex.: Central de mensagens refinada" />
        </Field>
        <Field label="Resumo" hint="Obrigatório para publicar (aparece no feed).">
          <Textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={2} maxLength={600} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Categoria">
            <Select value={category} onChange={(event) => setCategory(event.target.value)}>
              {CHANGELOG_CATEGORIES.map((value) => (
                <option key={value} value={value}>{CHANGELOG_CATEGORY_LABELS[value]}</option>
              ))}
            </Select>
          </Field>
          <Field label="Autor">
            <Input value={author} onChange={(event) => setAuthor(event.target.value)} maxLength={120} placeholder="Equipe AtendON" />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Slug (permalink)" hint={lockedSlug ? "Imutável após a primeira publicação." : "Vazio gera slug a partir do título."}>
            <Input value={slug} onChange={(event) => setSlug(event.target.value)} maxLength={120} disabled={lockedSlug} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="central-de-mensagens" />
          </Field>
          <Field label="Rótulo de versão" hint={post ? (post.releaseId ? `Importado de release (proveniência ${post.releaseId.slice(0, 8)}…).` : "Somente leitura; definido por import curado.") : "Definido por import curado de release."}>
            <Input value={versionLabel} readOnly placeholder="—" aria-label="Rótulo de versão (somente leitura)" />
          </Field>
        </div>
        <Field label="Corpo (texto plano)" hint="Parágrafos separados por linha em branco; sem markdown ou HTML.">
          <Textarea value={contentText} onChange={(event) => setContentText(event.target.value)} rows={8} placeholder={"Primeiro parágrafo.\n\nSegundo parágrafo."} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Módulos afetados" hint="Separados por vírgula.">
            <Input value={modules} onChange={(event) => setModules(event.target.value)} placeholder="panel, conversas" />
          </Field>
          <Field label="Planos afetados" hint="Nomes exatos dos planos; vazio = todos.">
            <Input value={plans} onChange={(event) => setPlans(event.target.value)} placeholder="Profissional, Enterprise" />
          </Field>
        </div>
        <fieldset className="grid gap-2">
          <legend className="label">Links relacionados (https)</legend>
          {links.map((link, index) => (
            <div key={index} className="flex items-end gap-2">
              <Field label={index === 0 ? "Rótulo" : undefined}>
                <Input value={link.label} onChange={(event) => setLinks((current) => current.map((item, position) => (position === index ? { ...item, label: event.target.value } : item)))} maxLength={200} aria-label={`Rótulo do link ${index + 1}`} />
              </Field>
              <Field label={index === 0 ? "URL" : undefined}>
                <Input value={link.url} onChange={(event) => setLinks((current) => current.map((item, position) => (position === index ? { ...item, url: event.target.value } : item)))} maxLength={2000} type="url" placeholder="https://…" aria-label={`URL do link ${index + 1}`} />
              </Field>
              <IconButton label={`Remover link ${index + 1}`} tone="danger" size="sm" onClick={() => setLinks((current) => current.filter((_, position) => position !== index))}>
                <Trash size={14} aria-hidden="true" />
              </IconButton>
            </div>
          ))}
          <Button size="sm" className="justify-self-start" onClick={() => setLinks((current) => [...current, { label: "", url: "" }])}>
            <Plus size={14} aria-hidden="true" />Adicionar link
          </Button>
        </fieldset>
        {!post ? (
          <Field label="Agendar publicação (opcional)" hint="Vazio cria rascunho; data futura agenda; data passada publica imediatamente (exige resumo).">
            <Input type="datetime-local" value={publishAt} onChange={(event) => setPublishAt(event.target.value)} />
          </Field>
        ) : null}
        {post ? (
          <fieldset className="grid gap-2">
            <legend className="label">Mídia anexada ({media.length})</legend>
            {media.length ? (
              <ul className="grid">
                {media.map((item, index) => (
                  <MediaRow
                    key={item.id}
                    item={item}
                    index={index}
                    total={media.length}
                    disabled={uploading}
                    onReplaced={(updated) => setMedia((current) => current.map((entry) => (entry.id === updated.id ? { ...entry, alt: updated.alt } : entry)))}
                    onMove={(from, to) => {
                      const next = [...media];
                      const [moved] = next.splice(from, 1);
                      next.splice(to, 0, moved);
                      void replaceMediaSet(next.map((entry) => entry.id));
                    }}
                  />
                ))}
              </ul>
            ) : (
              <p className="sub text-sm">Nenhuma mídia anexada.</p>
            )}
            <div className="grid gap-2 border-y border-[var(--border)] py-3">
              <Field label="Enviar mídia" hint="PNG, JPEG, GIF, WEBP ou MP4 (até 10MB); enviada já anexada ao post.">
                <input ref={fileRef} type="file" accept={MEDIA_ACCEPT} className="input" onChange={onFileChange} aria-label="Arquivo de mídia" />
              </Field>
              <Field label="Descrição (alt) do envio">
                <Input value={uploadAlt} onChange={(event) => setUploadAlt(event.target.value)} maxLength={300} disabled={uploading} />
              </Field>
              <Button size="sm" className="justify-self-start" onClick={() => void uploadMedia()} disabled={uploading}>
                <FileArrowUp size={14} aria-hidden="true" />{uploading ? "Enviando…" : "Enviar mídia"}
              </Button>
            </div>
          </fieldset>
        ) : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
        {post && !post.releaseId && post.versionLabel ? (
          <p className="sub text-xs">Rótulo de versão: <Badge tone="neutral" variant="outline">{post.versionLabel}</Badge></p>
        ) : null}
      </form>
    </Dialog>
  );
}
