"use client";

/**
 * Notas internas do contato (R3 v6): GET/POST /leads/:id/notes com @menções.
 * Card pronto para o app/contatos/[id]/page.tsx (integração via patch).
 */

import useSWR from "swr";
import { api } from "@/lib/api";
import { canAccessWithSession, type PanelSession } from "@/lib/session";
import { NoteComposer, NoteList, type NotesResponse } from "./notes-shared";

const fetcher = <T,>(url: string) => api<T>(url);

export function LeadNotes({ leadId }: { leadId: string }) {
  const { data: session } = useSWR<PanelSession>("/me", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 10_000
  });
  const canRead = Boolean(session && canAccessWithSession(session, ["leads.follow_up.read"]));
  const canManage = Boolean(session && canAccessWithSession(session, ["leads.follow_up.manage"]));
  const notesPath = `/leads/${encodeURIComponent(leadId)}/notes`;
  const { data, error, mutate } = useSWR<NotesResponse>(canRead && leadId ? notesPath : null, fetcher, {
    revalidateOnFocus: false
  });

  if (!canRead) return null;

  return (
    <section className="card" aria-labelledby="lead-notes-title">
      <div id="lead-notes-title" className="cardtitle">Notas internas</div>
      <p className="sub mb-4">Registro interno do contato, visível apenas para membros autorizados.</p>
      {canManage ? (
        <div className="mb-5 border-b border-[var(--border)] pb-5">
          <NoteComposer
            endpoint={notesPath}
            textareaId="lead-note-editor"
            canManage
            onCreated={() => mutate()}
          />
        </div>
      ) : null}
      {error ? <p className="error" role="alert">{error.message}</p> : null}
      <NoteList items={data?.items ?? []} emptyLabel="Nenhuma nota interna registrada." />
    </section>
  );
}
