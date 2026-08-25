import { ArrowSquareOut, FacebookLogo, InstagramLogo, Megaphone } from "@phosphor-icons/react";
import React from "react";

type Attribution = Record<string, unknown> | null | undefined;

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result || undefined;
}

function safeWebUrl(value: unknown): string | undefined {
  const result = text(value);
  if (!result) return undefined;
  try {
    const url = new URL(result);
    return url.protocol === "https:" || url.protocol === "http:" ? result : undefined;
  } catch {
    return undefined;
  }
}

function prefilledEntries(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value)
    .flatMap(([label, answer]) => {
      const cleanLabel = text(label);
      const cleanAnswer = text(answer);
      return cleanLabel && cleanAnswer ? [[cleanLabel, cleanAnswer] as [string, string]] : [];
    })
    .slice(0, 40);
}

export function ConversationReferral({ attribution }: { attribution: Attribution }) {
  if (!attribution || typeof attribution !== "object" || Array.isArray(attribution)) return null;

  const headline = text(attribution.headline);
  const body = text(attribution.body);
  const sourceId = text(attribution.source_id);
  const sourceType = text(attribution.source_type);
  const sourceApp = text(attribution.source_app) ?? text(attribution.channel);
  const sourceUrl = safeWebUrl(attribution.source_url) ?? safeWebUrl(attribution.media_url);
  const thumbnailUrl = safeWebUrl(attribution.thumbnail_url);
  const fields = prefilledEntries(attribution.prefilled_fields);
  const isInstagram = sourceApp?.toLowerCase() === "instagram";
  const platform = isInstagram ? "Instagram" : "Facebook";
  const PlatformIcon = isInstagram ? InstagramLogo : FacebookLogo;

  if (!headline && !body && !sourceId && !sourceUrl && !thumbnailUrl && fields.length === 0) return null;

  return (
    <section
      className="conversation-referral mb-4 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--primary-tint-border)] bg-[var(--primary-tint-bg)]"
      aria-label={`Origem da conversa: ${platform}`}
    >
      <div className="grid grid-cols-[3px_minmax(0,1fr)]">
        <div className="bg-[var(--primary)]" aria-hidden="true" />
        <div className="min-w-0 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-lg)] border border-[var(--primary-tint-border)] text-[var(--primary-text)]">
                <PlatformIcon size={19} weight="duotone" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--primary-text)]">
                  <Megaphone size={13} weight="bold" aria-hidden="true" />
                  {sourceType === "ad" ? `Anúncio do ${platform}` : `Origem ${platform}`}
                </span>
                <p className="mt-1 text-xs text-[var(--muted)]">Este contato iniciou a conversa por uma campanha da Meta.</p>
              </div>
            </div>
            {sourceUrl ? (
              <a
                className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--text-4)] transition hover:border-[var(--border-hover)] hover:text-[var(--text)] active:scale-[.98]"
                href={sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                Ver publicação
                <ArrowSquareOut size={13} aria-hidden="true" />
              </a>
            ) : null}
          </div>

          <div className={`mt-4 grid gap-4 ${thumbnailUrl ? "sm:grid-cols-[112px_minmax(0,1fr)]" : ""}`}>
            {thumbnailUrl ? (
              // A URL vem sanitizada do backend e é renderizada sem enviar o referrer do painel.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="aspect-video w-full rounded-[9px] border border-[var(--border)] object-cover sm:aspect-square"
                src={thumbnailUrl}
                alt="Prévia visual da campanha"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : null}
            <div className="min-w-0">
              {headline ? <strong className="block text-sm leading-snug text-[var(--text)]">{headline}</strong> : null}
              {body && body !== headline ? <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-[var(--body)]">{body}</p> : null}
              {sourceId ? (
                <p className="mono mt-3 truncate text-[10px] text-[var(--faint)]" title={sourceId}>
                  ID do anúncio · {sourceId}
                </p>
              ) : null}
            </div>
          </div>

          {fields.length > 0 ? (
            <dl className="mt-4 grid gap-x-6 gap-y-3 border-t border-[var(--border)] pt-4 sm:grid-cols-2">
              {fields.map(([label, answer]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--faint)]">{label}</dt>
                  <dd className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-[var(--text)]">{answer}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      </div>
    </section>
  );
}
