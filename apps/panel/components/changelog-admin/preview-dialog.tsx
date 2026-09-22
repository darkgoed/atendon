"use client";

/**
 * Prévia editorial (viewer no-store) de draft/agendado/despublicado: consome
 * GET /root/changelog/posts/:id/preview — mesmo shape do payload público +
 * flags admin { status, publishAt }. Render sempre em texto plano por
 * parágrafos (proibido markdown/HTML/dangerouslySetInnerHTML).
 */

import { useEffect, useState } from "react";
import { Badge, Button, Dialog, ErrorState, LoadingState } from "@/components/ui";
import { api } from "@/lib/api";
import {
  CHANGELOG_STATUS_LABELS,
  changelogApiUrl,
  changelogCategoryLabel,
  isChangelogVideoMime,
  splitParagraphs,
  type ChangelogPublicPost,
  type ChangelogStatus
} from "@/lib/changelog";

type PreviewPayload = ChangelogPublicPost & { status: ChangelogStatus; publishAt: string | null };

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" });

export function PreviewDialog({
  post,
  onClose
}: {
  post: { id: string; title: string } | null;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!post) {
      setPreview(null);
      setError("");
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    setPreview(null);
    api<{ post: PreviewPayload }>(`/root/changelog/posts/${post.id}/preview`, { cache: "no-store" })
      .then((response) => {
        if (active) setPreview(response.post);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Não foi possível carregar a prévia.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [post]);

  return (
    <Dialog
      open={Boolean(post)}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={post ? `Prévia: ${post.title}` : "Prévia"}
      description="Exatamente o payload público, servido no-store — o que o leitor verá."
      size="lg"
      footer={<Button onClick={onClose}>Fechar</Button>}
    >
      {loading ? <LoadingState label="Carregando prévia" /> : null}
      {error ? <ErrorState title="Não foi possível carregar a prévia">{error}</ErrorState> : null}
      {preview ? (
        <article className="grid gap-3" data-changelog-preview={preview.slug}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="info" variant="pill">{changelogCategoryLabel(preview.category)}</Badge>
            <Badge tone={preview.status === "published" ? "success" : preview.status === "scheduled" ? "warning" : "neutral"} variant="outline">
              {CHANGELOG_STATUS_LABELS[preview.status]}
            </Badge>
            {preview.publishAt ? <span className="sub text-sm">Agendada para {dateTime.format(new Date(preview.publishAt))}</span> : null}
            {preview.publishedAt ? <span className="sub text-sm">{dateOnly.format(new Date(preview.publishedAt))}</span> : null}
            {preview.author ? <span className="sub text-sm">· {preview.author}</span> : null}
          </div>
          <h3 className="text-lg">{preview.title}</h3>
          {preview.summary ? <p className="sub">{preview.summary}</p> : null}
          {splitParagraphs(preview.contentText).map((paragraph, index) => (
            <p key={index} className="whitespace-pre-line">{paragraph}</p>
          ))}
          {preview.media.length ? (
            <div className="flex flex-wrap gap-2">
              {preview.media.map((item) =>
                isChangelogVideoMime(item.mime) ? (
                  <video key={item.id} src={changelogApiUrl(`/root/changelog/media/${item.id}/bytes`)} controls preload="metadata" className="max-h-64 rounded-[var(--radius-sm,6px)] border border-[var(--border)]" aria-label={item.alt ?? "Mídia do post"} />
                ) : (
                  // Mídia autenticada no-store; o otimizador do Next não repassa cookie.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={item.id} src={changelogApiUrl(`/root/changelog/media/${item.id}/bytes`)} alt={item.alt ?? ""} loading="lazy" className="max-h-64 rounded-[var(--radius-sm,6px)] border border-[var(--border)]" />
                )
              )}
            </div>
          ) : null}
          {preview.relatedLinks.length ? (
            <ul className="list-disc list-inside text-sm">
              {preview.relatedLinks.map((link) => (
                <li key={link.url}>
                  <a href={link.url} target="_blank" rel="noreferrer">{link.label}</a>
                </li>
              ))}
            </ul>
          ) : null}
          {preview.modulesAffected.length ? <p className="sub text-sm">Módulos afetados: {preview.modulesAffected.join(", ")}</p> : null}
        </article>
      ) : null}
    </Dialog>
  );
}
