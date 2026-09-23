"use client";

/**
 * "Novidades" (rota /changelog, menu:false): o MESMO feed global do changelog
 * editorial + read-state por usuário. Elegibilidade/read-state vindos de
 * /panel/changelog/feed e /panel/changelog/unread; visualizar o post marca
 * leitura via POST /panel/changelog/read (idempotente no backend). Corpo é
 * TEXTO PLANO por parágrafos — proibido markdown/HTML/dangerouslySetInnerHTML.
 * Páginas dinâmicas: fetch sempre cache:"no-store" (revogabilidade da SPEC).
 */

import { CaretDown, CaretUp } from "@/components/icons";
import { useState } from "react";
import useSWR from "swr";
import { Shell } from "@/components/shell";
import { Badge, Button, Dot, EmptyState, ErrorState, IconButton, LoadingState, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import {
  changelogApiUrl,
  changelogCategoryLabel,
  isChangelogVideoMime,
  splitParagraphs,
  type ChangelogFeedPost,
  type ChangelogUnread
} from "@/lib/changelog";

// Páginas NÃO servem publicado de cache: cada fetch vai ao backend sem cache.
const fetcher = <T,>(url: string) => api<T>(url, { cache: "no-store" });

const FEED_LIMIT = 20;
const dateOnly = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" });

export default function ChangelogPage() {
  const { data: feed, error: feedError, mutate: mutateFeed } = useSWR<{ posts: ChangelogFeedPost[]; nextOffset: number | null }>(
    `/panel/changelog/feed?limit=${FEED_LIMIT}`,
    fetcher,
    { revalidateOnFocus: false }
  );
  const { data: unread, mutate: mutateUnread } = useSWR<ChangelogUnread>("/panel/changelog/unread", fetcher, {
    revalidateOnFocus: false
  });
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState("");
  const posts = feed?.posts ?? [];

  // Marca leitura ao VISUALIZAR o post. user_id é sempre o da sessão (servidor
  // ignora body); idempotente. O feed ainda não expõe o id interno (gap de
  // contrato documentado nas evidências): sem id, degrada sem crash e sem call.
  function view(post: ChangelogFeedPost) {
    const next = openSlug === post.slug ? null : post.slug;
    setOpenSlug(next);
    if (!next || post.read || !post.id) return;
    mutateFeed(
      (current) => (current ? { ...current, posts: current.posts.map((item) => (item.slug === post.slug ? { ...item, read: true } : item)) } : current),
      false
    );
    mutateUnread((current) => (current ? { ...current, count: Math.max(0, current.count - 1) } : current), false);
    void api("/panel/changelog/read", { method: "POST", body: JSON.stringify({ postId: post.id }) }).catch(() => {
      // Leitura otimista persiste visualmente; retry natural no próximo visualize.
    });
  }

  async function loadOlder() {
    if (!feed?.nextOffset || loadingMore) return;
    setLoadingMore(true);
    setMoreError("");
    try {
      const next = await api<{ posts: ChangelogFeedPost[]; nextOffset: number | null }>(
        `/panel/changelog/feed?limit=${FEED_LIMIT}&offset=${feed.nextOffset}`,
        { cache: "no-store" }
      );
      mutateFeed(
        (current) => {
          const seen = new Set((current?.posts ?? []).map((item) => item.slug));
          return {
            posts: [...(current?.posts ?? []), ...next.posts.filter((item) => !seen.has(item.slug))],
            nextOffset: next.nextOffset
          };
        },
        false
      );
    } catch (cause) {
      setMoreError(cause instanceof Error ? cause.message : "Não foi possível carregar atualizações anteriores.");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Shell>
      <div className="grid gap-4">
        <PageHeader title="Novidades" />
        {unread && unread.count > 0 ? (
          <p className="accent flex items-center gap-2" role="status">
            <Dot tone="primary" />
            {unread.count === 1 ? "1 novidade não lida" : `${unread.count} novidades não lidas`}
            {unread.latestPost ? ` — mais recente: ${unread.latestPost.title}` : ""}
          </p>
        ) : null}

        {feedError ? (
          <ErrorState title="Não foi possível carregar o changelog." action={<Button onClick={() => void mutateFeed()}>Tentar novamente</Button>} />
        ) : null}
        {!feed && !feedError ? <LoadingState label="Carregando novidades" /> : null}

        {feed && posts.length === 0 ? (
          <EmptyState title="Nenhuma novidade publicada ainda">Posts publicados pelo time do AtendON aparecem aqui automaticamente.</EmptyState>
        ) : null}

        <div className="grid gap-3">
          {posts.map((post) => {
            const isOpen = openSlug === post.slug;
            return (
              <article key={post.slug} className="card" data-changelog-post={post.slug}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="info" variant="pill">{changelogCategoryLabel(post.category)}</Badge>
                  {post.versionLabel ? <span className="sub mono">{post.versionLabel}</span> : null}
                  {post.read ? (
                    <Badge tone="neutral" variant="outline">Lida</Badge>
                  ) : (
                    <span className="accent flex items-center gap-1 text-sm">
                      <Dot tone="primary" />Nova
                    </span>
                  )}
                  <span className="sub ml-auto text-sm">
                    {post.publishedAt ? dateOnly.format(new Date(post.publishedAt)) : ""}
                    {post.author ? ` · ${post.author}` : ""}
                  </span>
                </div>
                <h2 className="mt-2">{post.title}</h2>
                {post.summary ? <p className="sub mt-1">{post.summary}</p> : null}
                <IconButton size="sm" className="mt-2" label={isOpen ? "Recolher" : "Ver post completo"} aria-expanded={isOpen} aria-controls={`changelog-body-${post.slug}`} onClick={() => view(post)}>
                  {isOpen ? <CaretUp size={14} aria-hidden="true" /> : <CaretDown size={14} aria-hidden="true" />}
                </IconButton>
                {isOpen ? (
                  <div id={`changelog-body-${post.slug}`} className="mt-3 grid gap-3 border-t border-[var(--border)] pt-3">
                    {splitParagraphs(post.contentText).map((paragraph, index) => (
                      <p key={index} className="whitespace-pre-line">{paragraph}</p>
                    ))}
                    {post.media.length ? (
                      <div className="flex flex-wrap gap-2">
                        {post.media.map((item) =>
                          isChangelogVideoMime(item.mime) ? (
                            <video key={item.id} src={changelogApiUrl(`/public/changelog/media/${item.id}`)} controls preload="metadata" aria-label={item.alt ?? "Mídia do post"} className="max-h-64 rounded-[var(--radius-sm,6px)] border border-[var(--border)]" />
                          ) : (
                            // Mídia pública revogável (no-store no backend); o otimizador
                            // de imagem do Next não participa deste caminho.
                            // eslint-disable-next-line @next/next/no-img-element
                            <img key={item.id} src={changelogApiUrl(`/public/changelog/media/${item.id}`)} alt={item.alt ?? ""} loading="lazy" className="max-h-64 rounded-[var(--radius-sm,6px)] border border-[var(--border)]" />
                          )
                        )}
                      </div>
                    ) : null}
                    {post.relatedLinks.length ? (
                      <ul className="list-disc list-inside text-sm">
                        {post.relatedLinks.map((link) => (
                          <li key={link.url}>
                            <a href={link.url} target="_blank" rel="noreferrer">{link.label}</a>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {post.modulesAffected.length ? <p className="sub text-sm">Módulos afetados: {post.modulesAffected.join(", ")}</p> : null}
                    {post.affectedPlans.length ? <p className="sub text-sm">Planos afetados: {post.affectedPlans.join(", ")}</p> : null}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>

        {moreError ? <p className="error" role="alert">{moreError}</p> : null}
        {feed?.nextOffset ? (
          <Button className="justify-self-start" disabled={loadingMore} onClick={() => void loadOlder()}>
            {loadingMore ? "Carregando…" : "Carregar atualizações anteriores"}
          </Button>
        ) : null}
      </div>
    </Shell>
  );
}
