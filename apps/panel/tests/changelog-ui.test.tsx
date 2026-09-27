// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api }));
vi.mock("../components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

import ChangelogPage from "../app/changelog/page";
import RootChangelogPage from "../app/root/changelog/page";
import type { ChangelogAdminPost, ChangelogFeedPost } from "../lib/changelog";

const rootSession = { user: { id: "root", email: "root@example.com", isRoot: true, name: "Root" }, activeWorkspace: null, workspaces: [], permissions: [], actorScope: "root" };

const adminPost: ChangelogAdminPost = {
  id: "qa-changelog-post-0001",
  releaseId: null,
  slug: "lancamento-qa-do-changelog",
  versionLabel: null,
  title: "Lançamento QA do changelog",
  summary: "Resumo editorial QA do post.",
  category: "melhoria",
  author: "Equipe AtendON",
  contentText: "Primeiro parágrafo QA.\n\nSegundo parágrafo QA.",
  modulesAffected: ["panel"],
  affectedPlans: [],
  relatedLinks: [],
  publishAt: null,
  published: false,
  publishedAt: null,
  status: "draft",
  createdByUserId: null,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:00.000Z",
  media: []
};

const feedPostUnread: ChangelogFeedPost = {
  id: "qa-feed-post-unread",
  slug: "novidades-qa-setembro",
  versionLabel: null,
  title: "Novidades de setembro no AtendON",
  summary: "Resumo do post novo.",
  category: "novo",
  author: "Equipe AtendON",
  publishedAt: "2026-09-10T12:00:00.000Z",
  contentText: "Primeiro parágrafo público.\n\nSegundo parágrafo público.",
  relatedLinks: [{ label: "Documentação", url: "https://docs.example.test/novidades" }],
  modulesAffected: ["panel"],
  affectedPlans: [],
  media: [{ id: "qa-feed-media-1", alt: "Print QA do recurso", mime: "image/png" }],
  read: false
};

const feedPostRead = {
  ...feedPostUnread,
  id: "qa-feed-post-read",
  slug: "novidades-qa-agosto",
  title: "Novidades de agosto no AtendON",
  read: true
};

function renderPage(node: React.ReactElement) {
  return render(<SWRConfig value={{ provider: () => new Map() }}>{node}</SWRConfig>);
}

function callsFor(path: string) {
  return api.mock.calls.filter(([calledPath]) => calledPath === path);
}

function lastCall(path: string) {
  const calls = callsFor(path);
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1];
}

function mockAdminList(post = adminPost) {
  api.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path === "/me") return rootSession;
    if (path.startsWith("/root/changelog/posts?status=")) return { posts: [post], nextOffset: null };
    if (path === "/root/changelog/posts" && init?.method === "POST") return { post };
    if (path === `/root/changelog/posts/${post.id}/publish`) return { post: { ...post, published: true, publishedAt: "2026-09-22T12:00:00.000Z", status: "published" } };
    if (path === `/root/changelog/posts/${post.id}/unpublish`) return undefined;
    if (path === `/root/changelog/posts/${post.id}/media`) return { media: post.media };
    if (path === "/root/changelog/media") return { media: { id: "qa-media-new", sha256: "qa-sha", mime: "image/png", sizeBytes: 4, alt: null } };
    return {};
  });
}

function mockPublicFeed(posts = [feedPostUnread, feedPostRead]) {
  api.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path.startsWith("/panel/changelog/feed")) return { posts, nextOffset: null };
    if (path === "/panel/changelog/unread") return { count: posts.filter((post) => !post.read).length, latestPost: { slug: posts[0].slug, title: posts[0].title, category: posts[0].category, publishedAt: posts[0].publishedAt } };
    if (path === "/panel/changelog/read" && init?.method === "POST") return undefined;
    return {};
  });
}

describe("admin /root/changelog", () => {
  beforeEach(() => {
    cleanup();
    api.mockReset();
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  it("lista posts com status, categoria e permalink", async () => {
    mockAdminList();
    renderPage(<RootChangelogPage />);
    expect(await screen.findByText("Lançamento QA do changelog")).toBeInTheDocument();
    expect(screen.getByText("Rascunho")).toBeInTheDocument();
    expect(screen.getByText("Melhoria")).toBeInTheDocument();
    expect(screen.getByText("/changelog/lancamento-qa-do-changelog")).toBeInTheDocument();
    expect(callsFor("/root/changelog/posts?status=all&limit=50")).toHaveLength(1);
  });

  it("filtra por status selecionado", async () => {
    mockAdminList();
    const user = userEvent.setup();
    renderPage(<RootChangelogPage />);
    await screen.findByText("Lançamento QA do changelog");
    await user.selectOptions(screen.getByLabelText("Filtrar por status"), "draft");
    await waitFor(() => expect(callsFor("/root/changelog/posts?status=draft&limit=50")).toHaveLength(1));
  });

  it("cria post com payload editorial exato (parágrafos, módulos, planos)", async () => {
    mockAdminList();
    const user = userEvent.setup();
    renderPage(<RootChangelogPage />);
    await user.click(await screen.findByRole("button", { name: "Novo post" }));
    await user.type(screen.getByLabelText("Título"), "Post criado em QA");
    await user.type(screen.getByLabelText("Resumo"), "Resumo obrigatório para publicar.");
    await user.type(screen.getByLabelText("Corpo (texto plano)"), "Parágrafo um.\n\nParágrafo dois.");
    await user.type(screen.getByLabelText("Módulos afetados"), "panel, conversas");
    fireEvent.submit(document.getElementById("changelog-post-form") as HTMLFormElement);
    await waitFor(() => expect(callsFor("/root/changelog/posts")).toHaveLength(1));
    const [, init] = lastCall("/root/changelog/posts");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      title: "Post criado em QA",
      summary: "Resumo obrigatório para publicar.",
      category: "novo",
      author: undefined,
      contentText: "Parágrafo um.\n\nParágrafo dois.",
      modulesAffected: ["panel", "conversas"],
      affectedPlans: []
    });
  });

  it("publica imediatamente (POST publish sem body)", async () => {
    mockAdminList();
    const user = userEvent.setup();
    renderPage(<RootChangelogPage />);
    await user.click(await screen.findByRole("button", { name: "Publicar…" }));
    fireEvent.submit(document.getElementById("changelog-publish-form") as HTMLFormElement);
    await waitFor(() => expect(callsFor(`/root/changelog/posts/${adminPost.id}/publish`)).toHaveLength(1));
    const [, init] = lastCall(`/root/changelog/posts/${adminPost.id}/publish`);
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(await screen.findByText("Post publicado.")).toBeInTheDocument();
  });

  it("despublica post publicado (POST unpublish)", async () => {
    mockAdminList({ ...adminPost, published: true, publishedAt: "2026-09-20T12:00:00.000Z", status: "published" });
    const user = userEvent.setup();
    renderPage(<RootChangelogPage />);
    await user.click(await screen.findByRole("button", { name: "Despublicar" }));
    await waitFor(() => expect(callsFor(`/root/changelog/posts/${adminPost.id}/unpublish`)).toHaveLength(1));
    const [, init] = lastCall(`/root/changelog/posts/${adminPost.id}/unpublish`);
    expect(init.method).toBe("POST");
  });

  it("envia mídia por multipart e anexa via PUT mediaIds", async () => {
    mockAdminList({ ...adminPost, media: [{ id: "qa-media-1", alt: "Print QA", mime: "image/png", sizeBytes: 10 }] });
    const user = userEvent.setup();
    renderPage(<RootChangelogPage />);
    await user.click(await screen.findByRole("button", { name: "Editar" }));
    const fileInput = await screen.findByLabelText("Arquivo de mídia");
    fireEvent.change(fileInput, { target: { files: [new File([new Uint8Array([137, 80, 78, 71])], "print.png", { type: "image/png" })] } });
    await user.type(screen.getByLabelText("Descrição (alt) do envio"), "Captura anexada");
    await user.click(screen.getByRole("button", { name: "Enviar mídia" }));
    await waitFor(() => expect(callsFor("/root/changelog/media")).toHaveLength(1));
    const [, uploadInit] = lastCall("/root/changelog/media");
    expect(uploadInit.method).toBe("POST");
    expect(uploadInit.body).toBeInstanceOf(FormData);
    await waitFor(() => expect(callsFor(`/root/changelog/posts/${adminPost.id}/media`)).toHaveLength(1));
    const [, attachInit] = lastCall(`/root/changelog/posts/${adminPost.id}/media`);
    expect(attachInit.method).toBe("PUT");
    expect(JSON.parse(attachInit.body)).toEqual({ mediaIds: ["qa-media-1", "qa-media-new"] });
  });
});

describe("/changelog (Novidades)", () => {
  beforeEach(() => {
    cleanup();
    api.mockReset();
  });

  it("renderiza feed global com unread, flags de leitura e mídia no expand", async () => {
    mockPublicFeed();
    const user = userEvent.setup();
    renderPage(<ChangelogPage />);
    expect(await screen.findByRole("heading", { name: "Novidades" })).toBeInTheDocument();
    expect(await screen.findByText(/1 novidade não lida/)).toBeInTheDocument();
    expect(screen.getByText("Lida")).toBeInTheDocument();
    expect(screen.getByText("Nova")).toBeInTheDocument();
    const article = (await screen.findByText("Novidades de setembro no AtendON")).closest("article") as HTMLElement;
    await user.click(within(article).getByRole("button", { name: /Ver post completo/ }));
    const image = await screen.findByAltText("Print QA do recurso");
    expect(image).toHaveAttribute("src", "/backend/public/changelog/media/qa-feed-media-1");
    expect(screen.getByText("Primeiro parágrafo público.")).toBeInTheDocument();
    expect(screen.getByText("Segundo parágrafo público.")).toBeInTheDocument();
  });

  it("marca leitura ao visualizar (POST /panel/changelog/read com postId da sessão-side)", async () => {
    mockPublicFeed();
    const user = userEvent.setup();
    renderPage(<ChangelogPage />);
    const unreadArticle = (await screen.findByText("Novidades de setembro no AtendON")).closest("article") as HTMLElement;
    await user.click(within(unreadArticle).getByRole("button", { name: /Ver post completo/ }));
    await waitFor(() => expect(callsFor("/panel/changelog/read")).toHaveLength(1));
    const [, init] = lastCall("/panel/changelog/read");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ postId: "qa-feed-post-unread" });
    await waitFor(() => expect(within(unreadArticle).getByText("Lida")).toBeInTheDocument());
    expect(screen.queryByText(/não lida/)).toBeNull();
    expect(screen.getAllByText("Lida")).toHaveLength(2);
  });

  it("não chama read quando o feed não expõe id (gap de contrato degrada sem crash)", async () => {
    const postWithoutId: ChangelogFeedPost = { ...feedPostUnread };
    delete postWithoutId.id;
    mockPublicFeed([postWithoutId, feedPostRead]);
    const user = userEvent.setup();
    renderPage(<ChangelogPage />);
    const article = (await screen.findByText("Novidades de setembro no AtendON")).closest("article") as HTMLElement;
    await user.click(within(article).getByRole("button", { name: /Ver post completo/ }));
    await screen.findByText("Primeiro parágrafo público.");
    expect(callsFor("/panel/changelog/read")).toHaveLength(0);
  });

  it("sem posts editoriais mostra as notas de versão publicadas (antes a página ficava vazia)", async () => {
    api.mockImplementation(async (path: string) => {
      if (path.startsWith("/panel/changelog/feed")) return { posts: [], nextOffset: null };
      if (path === "/panel/changelog/unread") return { count: 0, latestPost: null };
      if (path === "/panel/version") {
        return {
          version: "2.1.2",
          deployVersion: "2.1.2",
          buildNumber: 129,
          changelog: [
            { version: "2.1.1", date: "2026-09-20", changes: ["Agenda por equipe"] },
            { version: "2.1.2", date: "2026-09-24", changes: ["Uso no ciclo de cobrança", "Google Agenda mais estável"] }
          ]
        };
      }
      return {};
    });
    renderPage(<ChangelogPage />);
    expect(await screen.findByText("Uso no ciclo de cobrança")).toBeInTheDocument();
    expect(screen.getByText("Google Agenda mais estável")).toBeInTheDocument();
    expect(screen.queryByText("Nenhuma novidade publicada ainda")).toBeNull();
    const versions = Array.from(document.querySelectorAll("[data-changelog-release]")).map((node) => node.getAttribute("data-changelog-release"));
    expect(versions).toEqual(["2.1.2", "2.1.1"]);
    expect(screen.getByText("24/09/2026")).toBeInTheDocument();
  });

  it("carrega atualizações anteriores por offset com dedupe por slug", async () => {
    api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/panel/changelog/feed?limit=20") return { posts: [feedPostUnread], nextOffset: 20 };
      if (path === "/panel/changelog/feed?limit=20&offset=20") return { posts: [feedPostRead, feedPostUnread], nextOffset: null };
      if (path === "/panel/changelog/unread") return { count: 1, latestPost: null };
      if (path === "/panel/changelog/read" && init?.method === "POST") return undefined;
      return {};
    });
    const user = userEvent.setup();
    renderPage(<ChangelogPage />);
    await user.click(await screen.findByRole("button", { name: "Carregar atualizações anteriores" }));
    await screen.findByText("Novidades de agosto no AtendON");
    expect(screen.getAllByText(/Novidades de setembro no AtendON/)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Carregar atualizações anteriores" })).toBeNull();
  });

  it("renderiza corpo como texto plano por parágrafos e nunca HTML cru", async () => {
    mockPublicFeed();
    const user = userEvent.setup();
    renderPage(<ChangelogPage />);
    const article = (await screen.findByText("Novidades de setembro no AtendON")).closest("article") as HTMLElement;
    await user.click(within(article).getByRole("button", { name: /Ver post completo/ }));
    const body = (await screen.findByText("Primeiro parágrafo público.")).closest("div");
    expect(body?.querySelectorAll("p.whitespace-pre-line")).toHaveLength(2);
    expect(body?.querySelectorAll("p.whitespace-pre-line")[0].textContent).toBe("Primeiro parágrafo público.");
    expect(body?.querySelectorAll("p.whitespace-pre-line")[1].textContent).toBe("Segundo parágrafo público.");
    for (const source of ["app/changelog/page.tsx", "app/root/changelog/page.tsx", "components/changelog-admin/preview-dialog.tsx"]) {
      expect(/dangerouslySetInnerHTML\s*=/.test(readFileSync(join(process.cwd(), source), "utf8"))).toBe(false);
    }
  });
});
