// Changelog editorial GLOBAL (SPEC specs/active/changelog-product-20260921.md):
// tipos e formatação compartilhados entre o admin /root/changelog e o feed
// autenticado /changelog ("Novidades"). Os payloads espelham EXATAMENTE os
// contratos pousados em apps/backend/src/modules/changelog/routes.ts
// (toPublicPost = whitelist fechada; toAdminPost = campos completos + status).

export const CHANGELOG_CATEGORIES = [
  "novo",
  "melhoria",
  "correcao",
  "seguranca",
  "integracao",
  "performance",
  "outro"
] as const;

export type ChangelogCategory = (typeof CHANGELOG_CATEGORIES)[number];

export const CHANGELOG_CATEGORY_LABELS: Record<ChangelogCategory, string> = {
  novo: "Novo",
  melhoria: "Melhoria",
  correcao: "Correção",
  seguranca: "Segurança",
  integracao: "Integração",
  performance: "Performance",
  outro: "Outro"
};

export type ChangelogStatus = "draft" | "scheduled" | "published" | "unpublished";

export const CHANGELOG_STATUS_LABELS: Record<ChangelogStatus, string> = {
  draft: "Rascunho",
  scheduled: "Agendada",
  published: "Publicada",
  unpublished: "Despublicada"
};

export type ChangelogPublicPost = {
  slug: string;
  versionLabel: string | null;
  title: string;
  summary: string | null;
  category: string;
  author: string | null;
  publishedAt: string | null;
  contentText: string | null;
  relatedLinks: Array<{ label: string; url: string }>;
  modulesAffected: string[];
  affectedPlans: string[];
  media: Array<{ id: string; alt: string | null; mime: string }>;
};

// Feed autenticado (/panel/changelog/feed): MESMO payload público + `read`.
// `id` é opcional PORQUE o backend hoje não o expõe no feed (whitelist pública);
// a marcação de leitura usa o id quando presente até o gap de contrato ser
// resolvido no backend (EVIDENCIAS-f6a.md §2). Sem id: degrada sem crash.
export type ChangelogFeedPost = ChangelogPublicPost & { id?: string; read: boolean };

export type ChangelogFeedResponse = { posts: ChangelogFeedPost[]; nextOffset: number | null };

export type ChangelogUnread = {
  count: number;
  latestPost: { slug: string; title: string; category: string; publishedAt: string | null } | null;
};

export type ChangelogMediaRecord = { id: string; sha256: string; mime: string; sizeBytes: number; alt: string | null };

export type ChangelogAdminPost = {
  id: string;
  releaseId: string | null;
  slug: string;
  versionLabel: string | null;
  title: string;
  summary: string | null;
  category: string;
  author: string | null;
  contentText: string | null;
  modulesAffected: string[];
  affectedPlans: string[];
  relatedLinks: Array<{ label: string; url: string }>;
  publishAt: string | null;
  published: boolean;
  publishedAt: string | null;
  status: ChangelogStatus;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  media: Array<{ id: string; alt: string | null; mime: string; sizeBytes: number }>;
};

export type ChangelogAdminListResponse = { posts: ChangelogAdminPost[]; nextOffset: number | null };

// Corpo em TEXTO PLANO preservado por parágrafos: linha em branco = parágrafo.
// Proibido markdown/HTML/parser — o render é sempre texto (React escapa).
export function splitParagraphs(contentText: string | null | undefined): string[] {
  if (!contentText) return [];
  return contentText
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export function changelogCategoryLabel(category: string): string {
  return CHANGELOG_CATEGORY_LABELS[category as ChangelogCategory] ?? category;
}

/** URL absoluta do backend para mídia servida por <img>/<video> (cookies same-origin). */
export function changelogApiUrl(path: string): string {
  return `${process.env.NEXT_PUBLIC_API_BASE_URL ?? "/backend"}${path}`;
}

export function isChangelogVideoMime(mime: string): boolean {
  return mime.startsWith("video/");
}
