"use client";

import type { ReactElement } from "react";

type Attribution = Record<string, unknown>;

function present(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readable(value: unknown): string | null {
  if (present(value)) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

export function ConversationPreBriefing({
  source, campaign, interest, facebookAttribution
}: {
  source: string | null;
  campaign: string | null;
  interest: string | null;
  facebookAttribution?: Attribution | null;
}): ReactElement {
  const facebookOrigin = readable(facebookAttribution?.origem_facebook);
  const origin = present(source) ? source : facebookOrigin;
  const rows = [
    ["Origem", origin],
    ["Campanha", campaign],
    ["Interesse", interest]
  ].filter(([, value]) => present(value));
  const hasData = rows.length > 0;

  return (
    <aside className="card" aria-labelledby="conversation-pre-briefing-title">
      <div id="conversation-pre-briefing-title" className="cardtitle">Pré-briefing</div>
      {!hasData ? <p className="mt-2 text-xs ">Sem dados de briefing ainda</p> : (
        <dl className="mt-3 grid gap-2 text-xs">
          {rows.map(([label, value]) => <div key={label} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2"><dt className="">{label}</dt><dd className="min-w-0 break-words ">{value}</dd></div>)}

        </dl>
      )}
    </aside>
  );
}
