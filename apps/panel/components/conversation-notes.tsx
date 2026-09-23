"use client";

/**
 * Nota interna da conversa (R3 v6). Por padrão renderiza SÓ o botão — o painel
 * lateral é renderizado estaticamente em teste (renderToStaticMarkup), então
 * as chaves SWR ficam null enquanto fechado e nada é buscado antes de abrir.
 */

import { useState } from "react";
import useSWR from "swr";
import { Notepad } from "@/components/icons";
import { api } from "@/lib/api";
import { canAccessWithSession, type PanelSession } from "@/lib/session";
import { IconButton } from "@/components/ui";
import { NoteComposer, NoteList, type NotesResponse } from "./notes-shared";
import styles from "./conversation-notes.module.css";

const fetcher = <T,>(url: string) => api<T>(url);

export function ConversationNotes({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false);
  const notesPath = `/conversations/${encodeURIComponent(conversationId)}/notes`;
  const { data: session } = useSWR<PanelSession>(open ? "/me" : null, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 10_000
  });
  const { data, error, mutate } = useSWR<NotesResponse>(open ? notesPath : null, fetcher, {
    revalidateOnFocus: false
  });
  const canReply = Boolean(session && canAccessWithSession(session, ["conversations.reply"]));

  if (!open) {
    // Minimalismo (README §4): ação secundária vira IconButton — o nome
    // acessível "Nota interna" permanece exatamente igual.
    return (
      <IconButton type="button" label="Nota interna" className={styles.trigger} aria-expanded={false} onClick={() => setOpen(true)}>
        <Notepad size={16} aria-hidden="true" />
      </IconButton>
    );
  }

  return (
    <div className={styles.wrap}>
      {canReply ? (
        <NoteComposer
          endpoint={notesPath}
          textareaId="conversation-note-editor"
          canManage
          onCreated={() => mutate()}
        />
      ) : null}
      {error ? <p className="error" role="alert">{error.message}</p> : null}
      <NoteList items={data?.items ?? []} emptyLabel="Nenhuma nota interna nesta conversa." />
    </div>
  );
}
