"use client";

/**
 * Administração ROOT do changelog editorial (SPEC specs/active/
 * changelog-product-20260921.md, seção FE admin): lista com filtro de status,
 * ciclo draft → scheduled → published → unpublished, mídia multipart e
 * prévia no-store. Primitivos do design system + tokens — nada hardcoded.
 * Nav rootOnly no panel-manifest é patch do worker de integração (fora daqui).
 */

import { type FormEvent, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import useSWR from "swr";
import { PostFormDialog } from "@/components/changelog-admin/post-form-dialog";
import { PreviewDialog } from "@/components/changelog-admin/preview-dialog";
import { Shell } from "@/components/shell";
import { Badge, type BadgeTone, Button, Dialog, EmptyState, ErrorState, Field, Input, LoadingState, PageHeader, Select, Table } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { CHANGELOG_STATUS_LABELS, changelogCategoryLabel, type ChangelogAdminListResponse, type ChangelogAdminPost, type ChangelogStatus } from "@/lib/changelog";
import type { PanelSession } from "@/lib/session";

const fetcher = <T,>(url: string) => api<T>(url);

const STATUS_FILTERS = [
  { value: "all", label: "Todos os status" },
  { value: "draft", label: "Rascunhos" },
  { value: "scheduled", label: "Agendadas" },
  { value: "published", label: "Publicadas" },
  { value: "unpublished", label: "Despublicadas" }
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]["value"];

const STATUS_TONES: Record<ChangelogStatus, BadgeTone> = {
  draft: "neutral",
  scheduled: "warning",
  published: "success",
  unpublished: "danger"
};

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

function publicationCell(post: ChangelogAdminPost): string {
  if (post.status === "scheduled" && post.publishAt) return `Agendada para ${dateTime.format(new Date(post.publishAt))}`;
  if (post.publishedAt) return dateTime.format(new Date(post.publishedAt));
  return "—";
}

export default function RootChangelogPage() {
  const { data: session } = useSWR<PanelSession>("/me", fetcher, { revalidateOnFocus: false });
  const root = Boolean(session?.user.isRoot);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const { data, error, mutate } = useSWR<ChangelogAdminListResponse>(
    root ? `/root/changelog/posts?status=${statusFilter}&limit=50` : null,
    fetcher,
    { revalidateOnFocus: false }
  );
  const [message, setMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [editing, setEditing] = useState<ChangelogAdminPost | null>(null);
  const [creating, setCreating] = useState(false);
  const [previewing, setPreviewing] = useState<ChangelogAdminPost | null>(null);
  const [publishing, setPublishing] = useState<ChangelogAdminPost | null>(null);
  const [publishAt, setPublishAt] = useState("");
  const [working, setWorking] = useState(false);
  const posts = data?.posts ?? [];

  if (!root) {
    return (
      <Shell>
        <div className="card">
          <p>Esta área está disponível apenas para usuários ROOT.</p>
        </div>
      </Shell>
    );
  }

  async function lifecycle(post: ChangelogAdminPost, action: "publish" | "unpublish" | "delete", body?: unknown) {
    setWorking(true);
    setMessage("");
    setActionError("");
    try {
      if (action === "delete") {
        await api(`/root/changelog/posts/${post.id}`, { method: "DELETE" });
        setMessage(`Post “${post.title}” excluído.`);
      } else {
        await api(`/root/changelog/posts/${post.id}/${action}`, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
        setMessage(
          action === "publish"
            ? post.status === "scheduled" || body
              ? "Agenda salva."
              : "Post publicado."
            : "Post despublicado (agenda cancelada)."
        );
      }
      await mutate();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : "Não foi possível concluir a ação.");
    } finally {
      setWorking(false);
    }
  }

  function requestDelete(post: ChangelogAdminPost) {
    if (!window.confirm(`Excluir o post “${post.title}”? O permalink público deixa de responder imediatamente.`)) return;
    void lifecycle(post, "delete");
  }

  function openPublish(post: ChangelogAdminPost) {
    setPublishAt("");
    setPublishing(post);
  }

  async function submitPublish(event: FormEvent) {
    event.preventDefault();
    const post = publishing;
    if (!post || working) return;
    await lifecycle(post, "publish", publishAt ? { publishAt: new Date(publishAt).toISOString() } : undefined);
    setPublishing(null);
  }

  function closeEditor() {
    setEditing(null);
    setCreating(false);
    void mutate();
  }

  return (
    <Shell>
      <div className="grid gap-4">
        <PageHeader
          title="Changelog editorial"
          actions={
            <div className="cluster">
              <Select aria-label="Filtrar por status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                {STATUS_FILTERS.map((filter) => (
                  <option key={filter.value} value={filter.value}>{filter.label}</option>
                ))}
              </Select>
              <Button tone="primary" onClick={() => setCreating(true)}>
                <Plus size={15} aria-hidden="true" />Novo post
              </Button>
            </div>
          }
        />

        {message ? <p className="accent" role="status">{message}</p> : null}
        {actionError ? <ErrorState title="Ação não concluída">{actionError}</ErrorState> : null}

        {error ? <ErrorState title="Não foi possível carregar os posts do changelog." action={<Button onClick={() => void mutate()}>Tentar novamente</Button>} /> : null}
        {!data && !error ? <LoadingState label="Carregando posts do changelog" /> : null}

        {data && posts.length === 0 ? (
          <EmptyState
            title="Nenhum post neste status"
            action={
              <Button tone="primary" onClick={() => setCreating(true)}>
                <Plus size={15} aria-hidden="true" />Criar o primeiro post
              </Button>
            }
          >
            O changelog editorial é global: posts publicados aqui alimentam o feed “Novidades” e o permalink público.
          </EmptyState>
        ) : null}

        {posts.length ? (
          <Table>
            <thead>
              <tr>
                <th scope="col">Post</th>
                <th scope="col">Status</th>
                <th scope="col">Categoria</th>
                <th scope="col">Publicação</th>
                <th scope="col">Módulos</th>
                <th scope="col">Ações</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((post) => (
                <tr key={post.id}>
                  <td data-label="Post">
                    <strong>{post.title}</strong>
                    <span className="sub mono block">/changelog/{post.slug}</span>
                  </td>
                  <td data-label="Status">
                    <Badge tone={STATUS_TONES[post.status]}>{CHANGELOG_STATUS_LABELS[post.status]}</Badge>
                  </td>
                  <td data-label="Categoria">
                    <Badge tone="info" variant="pill">{changelogCategoryLabel(post.category)}</Badge>
                  </td>
                  <td data-label="Publicação">{publicationCell(post)}</td>
                  <td data-label="Módulos">{post.modulesAffected.length ? post.modulesAffected.join(", ") : "—"}</td>
                  <td data-label="Ações">
                    <div className="cluster flex-wrap">
                      <Button size="sm" onClick={() => setEditing(post)}>Editar</Button>
                      <Button size="sm" onClick={() => setPreviewing(post)}>Prévia</Button>
                      {post.status === "published" ? (
                        <Button size="sm" tone="danger" disabled={working} onClick={() => void lifecycle(post, "unpublish")}>Despublicar</Button>
                      ) : post.status === "scheduled" ? (
                        <>
                          <Button size="sm" tone="danger" disabled={working} onClick={() => void lifecycle(post, "unpublish")}>Cancelar agenda</Button>
                          <Button size="sm" tone="primary" disabled={working} onClick={() => openPublish(post)}>Publicar agora</Button>
                        </>
                      ) : (
                        <Button size="sm" tone="primary" disabled={working} onClick={() => openPublish(post)}>Publicar…</Button>
                      )}
                      <Button size="sm" tone="danger" disabled={working} onClick={() => requestDelete(post)}>Excluir</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </div>

      <PostFormDialog
        open={creating || Boolean(editing)}
        post={editing}
        onClose={closeEditor}
        onSaved={() => {
          setEditing(null);
          setCreating(false);
          setMessage("Post salvo.");
          void mutate();
        }}
      />

      <PreviewDialog post={previewing} onClose={() => setPreviewing(null)} />

      <Dialog
        open={Boolean(publishing)}
        onOpenChange={(next) => {
          if (!next) setPublishing(null);
        }}
        title={publishing ? `Publicar: ${publishing.title}` : "Publicar"}
        description="Sem data publica imediatamente; com data futura agenda (o worker publica no tick)."
        footer={
          <>
            <Button onClick={() => setPublishing(null)} disabled={working}>Cancelar</Button>
            <Button tone="primary" type="submit" form="changelog-publish-form" disabled={working}>
              {publishAt ? "Agendar publicação" : "Publicar agora"}
            </Button>
          </>
        }
      >
        <form id="changelog-publish-form" className="grid gap-3" onSubmit={submitPublish}>
          <Field label="Agendar para (opcional)" hint="Data/hora futura agenda a publicação; vazio publica agora.">
            <Input type="datetime-local" value={publishAt} onChange={(event) => setPublishAt(event.target.value)} />
          </Field>
        </form>
      </Dialog>
    </Shell>
  );
}
