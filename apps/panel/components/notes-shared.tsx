"use client";

/**
 * Blocos compartilhados das notas internas com @menções (R3 v6): fonte única
 * de membros, textarea com autocomplete @, compositor e lista de notas.
 * Consumido por components/conversation-notes.tsx e components/lead-notes.tsx.
 */

import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { api } from "@/lib/api";
import { Button } from "@/components/ui";
import styles from "./conversation-notes.module.css";

export type InternalNote = {
  id: string;
  body: string;
  author_id: string;
  author_name: string | null;
  mentions: { id: string; name: string | null }[];
  created_at: string;
};

export type MentionMember = { user_id: string; name: string | null; email: string; status: string };

type MembersResponse = { members: MentionMember[] };
type NotesResponse = { items: InternalNote[] };

const fetcher = <T,>(url: string) => api<T>(url);
const MENTION_LIMIT = 6;

/** Fonte única de membros para @menções: apenas membros ativos do workspace. */
export function useMentionMembers(enabled: boolean): MentionMember[] {
  const { data } = useSWR<MembersResponse>(enabled ? "/workspaces/current/members" : null, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 30_000,
    shouldRetryOnError: false
  });
  return useMemo(
    () => (data?.members ?? []).filter((member) => member.status === "active"),
    [data]
  );
}

export function mentionDisplayName(member: MentionMember): string {
  return member.name?.trim() || member.email;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

/** Token @vigente: `@` + texto sem espaço imediatamente antes do cursor. */
function detectMentionToken(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)@(\S*)$/.exec(before);
  if (!match) return null;
  const at = before.length - match[1].length - 1;
  return { query: match[1], start: at };
}

export function MentionTextarea({
  value,
  onValueChange,
  onPickMention,
  members,
  textareaId,
  textareaLabel,
  placeholder,
  maxLength,
  disabled
}: {
  value: string;
  onValueChange: (next: string) => void;
  /** Chamado quando uma @menção é inserida no texto (id do membro). */
  onPickMention: (userId: string) => void;
  members: MentionMember[];
  textareaId: string;
  textareaLabel: string;
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [token, setToken] = useState<{ query: string; start: number } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const lowered = (token?.query ?? "").toLowerCase();
  const options = useMemo(
    () => members
      .filter((member) => mentionDisplayName(member).toLowerCase().includes(lowered) || member.email.toLowerCase().includes(lowered))
      .slice(0, MENTION_LIMIT),
    [members, lowered]
  );
  const open = Boolean(token) && !dismissed && options.length > 0;
  const safeIndex = options.length ? Math.min(activeIndex, options.length - 1) : 0;

  function handleChange(next: string, caret: number) {
    onValueChange(next);
    setToken(detectMentionToken(next, caret));
    setDismissed(false);
    setActiveIndex(0);
  }

  function pick(member: MentionMember) {
    const textarea = textareaRef.current;
    const caret = textarea?.selectionStart ?? value.length;
    const start = token?.start ?? caret;
    const before = value.slice(0, start);
    const after = value.slice(caret);
    const name = mentionDisplayName(member);
    const next = `${before}@${name} ${after}`;
    onValueChange(next);
    onPickMention(member.user_id);
    setToken(null);
    setDismissed(false);
    setActiveIndex(0);
    window.requestAnimationFrame(() => {
      textarea?.focus();
      const position = before.length + name.length + 2;
      textarea?.setSelectionRange(position, position);
    });
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (!open || !options.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((safeIndex + 1) % options.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((safeIndex - 1 + options.length) % options.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      pick(options[safeIndex]);
    } else if (event.key === "Escape") {
      // O painel lateral fecha por Escape no document; consumir aqui evita
      // fechar o painel inteiro ao dispensar apenas o popup de menções.
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
    }
  }

  return (
    <div className={styles.editorAnchor}>
      <textarea
        ref={textareaRef}
        id={textareaId}
        className={styles.editor}
        value={value}
        aria-label={textareaLabel}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        aria-autocomplete="list"
        aria-controls={open ? `${textareaId}-mentions` : undefined}
        onChange={(event) => handleChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          // Fecha depois do tick: o clique numa opção usa onMouseDown e não
          // deve perder a seleção para o blur.
          window.setTimeout(() => setToken(null), 150);
        }}
      />
      {open ? (
        <ul id={`${textareaId}-mentions`} className={styles.popup} role="listbox" aria-label="Menções da equipe">
          {options.map((member, index) => (
            <li key={member.user_id}>
              <button
                type="button"
                role="option"
                aria-selected={index === safeIndex}
                data-active={index === safeIndex}
                className={styles.mentionOption}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(member);
                }}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className={styles.mentionOptionName}>@{mentionDisplayName(member)}</span>
                <span className={styles.mentionOptionEmail}>{member.email}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {token && !dismissed && options.length === 0 ? (
        <div className={styles.popup}>
          <p className={styles.popupEmpty}>Nenhum membro da equipe para “@{token.query}”.</p>
        </div>
      ) : null}
    </div>
  );
}

export function NoteComposer({
  endpoint,
  textareaId,
  onCreated,
  placeholder = "Registre contexto interno. Use @ para mencionar um membro da equipe.",
  canManage,
  hint = "Use @ para mencionar um membro da equipe."
}: {
  endpoint: string;
  textareaId: string;
  onCreated: () => unknown | Promise<unknown>;
  placeholder?: string;
  canManage: boolean;
  hint?: string;
}) {
  const [body, setBody] = useState("");
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const members = useMentionMembers(canManage);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = body.trim();
    if (!text || saving) return;
    setSaving(true);
    setError("");
    try {
      await api(endpoint, {
        method: "POST",
        body: JSON.stringify({ body: text, ...(mentionIds.length ? { mentions: mentionIds } : {}) })
      });
      setBody("");
      setMentionIds([]);
      await onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao salvar a nota");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      <MentionTextarea
        value={body}
        onValueChange={setBody}
        onPickMention={(userId) => setMentionIds((current) => (current.includes(userId) ? current : [...current, userId]))}
        members={members}
        textareaId={textareaId}
        textareaLabel="Nova nota"
        placeholder={placeholder}
        maxLength={4000}
        disabled={saving}
      />
      <div className={styles.actions}>
        <span className={styles.hint}>{hint}</span>
        <Button tone="primary" size="sm" type="submit" disabled={saving || !body.trim()}>
          {saving ? "Salvando…" : "Salvar nota"}
        </Button>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </form>
  );
}

export function NoteList({ items, emptyLabel }: { items: InternalNote[]; emptyLabel: string }) {
  if (!items.length) return <p className={styles.hint} role="status">{emptyLabel}</p>;
  return (
    <ul className={styles.list}>
      {items.map((note) => (
        <li key={note.id} className={styles.note}>
          <p className={styles.noteBody}>{note.body}</p>
          <div className={styles.noteFooter}>
            <span>{note.author_name?.trim() || "Autor removido"}</span>
            <time dateTime={note.created_at}>{formatDate(note.created_at)}</time>
            {note.mentions.map((mention) => (
              <span key={mention.id} className={styles.mentionChip}>@{mention.name?.trim() || "membro"}</span>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

export type { NotesResponse };
