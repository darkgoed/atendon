"use client";

import { useState } from "react";
import useSWR from "swr";
import { Shell } from "@/components/shell";
import { Empty, LoadingCards } from "@/components/page-state";
import { api, type PublicRelease } from "@/lib/api";

const fetcher = <T,>(url: string) => api<T>(url);

export default function ChangelogPage() {
  const { data, error } = useSWR<{ releases: PublicRelease[] }>("/panel/versions?limit=100", fetcher, { revalidateOnFocus: false });
  const [open, setOpen] = useState<string | null>(null);
  const releases = data?.releases ?? [];

  return (
    <Shell>
      <div className="card admin-card">
        <h1>Changelog público</h1>
        <p className="sub">Novidades e correções publicadas para o seu workspace. Releases globais e específicas da sua empresa aparecem aqui.</p>
      </div>
      {error ? <p className="error mt-4" role="alert">Não foi possível carregar o changelog.</p> : null}
      {!data && !error ? <LoadingCards label="Carregando changelog" /> : null}
      {data && releases.length === 0 ? <div className="mt-4"><Empty>Nenhuma release publicada ainda.</Empty></div> : null}
      <div className="mt-4 space-y-3">
        {releases.map((release) => {
          const isOpen = open === release.version;
          return (
            <article key={release.version} className="card">
              <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => setOpen(isOpen ? null : release.version)} aria-expanded={isOpen}>
                <div>
                  <strong>{release.publicTitle ?? `AtendON ${release.version}`}</strong>
                  <span className="sub mono ml-2">v{release.version} · Build {release.buildNumber}</span>
                  <p className="sub">{release.publicSummary}</p>
                </div>
                <span className="sub">{(release.publishedAt ?? release.createdAt).slice(0, 10)}</span>
              </button>
              {isOpen && release.publicChanges.length > 0 ? (
                <ul className="mt-3 list-disc list-inside space-y-1 text-sm">
                  {release.publicChanges.map((change, index) => (
                    <li key={index}>{change.text}</li>
                  ))}
                </ul>
              ) : null}
            </article>
          );
        })}
      </div>
    </Shell>
  );
}
