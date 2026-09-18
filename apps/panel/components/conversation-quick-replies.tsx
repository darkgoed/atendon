"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ForwardedRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject
} from "react";
import useSWR from "swr";
import { api } from "@/lib/api";
import styles from "./conversation-quick-replies.module.css";

export type QuickReplyItem = { shortcut: string; body: string };
type QuickRepliesResponse = { items: QuickReplyItem[] };
type QuickRepliesSession = {
  user: { name: string | null; email: string };
  activeWorkspace: { timezone?: string } | null;
};

const QUICK_REPLY_LIMIT = 8;
const fetcher = <T,>(url: string) => api<T>(url);

// O token disparador é o texto INTEIRO "/palavra" no início do rascunho:
// apagar ou digitar fora dele fecha o popup naturalmente.
function quickReplyToken(draft: string): string | null {
  const match = /^\/(\S*)$/.exec(draft);
  return match ? match[1] : null;
}

function tenantDate(timezone?: string): string {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: timezone || undefined
    }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("pt-BR").format(new Date());
  }
}

// Compat: split/join em vez de replaceAll (Safari 12–15 sem polyfill garantido
// fora do layout raiz — lib/compat.ts cobre o app, o teste isola o componente).
function replaceToken(text: string, token: string, value: string) {
  return text.split(token).join(value);
}

export type ConversationQuickRepliesHandle = {
  // Consultado pelo composer ANTES do submit-guard: devolve true quando o
  // evento foi consumido pelo popup (já com preventDefault/stopPropagation).
  handleKeyDown: (event: ReactKeyboardEvent<Element>) => boolean;
};

export function ConversationQuickReplies({
  conversationId,
  contactName,
  draft,
  onReplaceDraft,
  textareaRef,
  controlRef
}: {
  conversationId: string;
  contactName?: string | null;
  draft: string;
  onReplaceDraft: (next: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  controlRef: ForwardedRef<ConversationQuickRepliesHandle>;
}) {
  const query = quickReplyToken(draft);
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  // SWR lazy: só busca /quick-replies quando o popup abre pela primeira vez —
  // `open` cobre a primeira abertura, loadedOnce evita refetch depois.
  const open = query !== null && dismissedQuery !== query;
  const shouldLoad = open || loadedOnce;
  useEffect(() => {
    if (open) setLoadedOnce(true);
  }, [open]);
  const { data } = useSWR<QuickRepliesResponse>(shouldLoad ? "/quick-replies" : null, fetcher, {
    revalidateOnFocus: false
  });
  const { data: session } = useSWR<QuickRepliesSession>(shouldLoad ? "/me" : null, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 10_000
  });

  const lowered = (query ?? "").toLowerCase();
  const items = data?.items ?? [];
  const visible = items
    .filter((item) => item.shortcut.toLowerCase().startsWith(lowered) || item.body.toLowerCase().includes(lowered))
    .slice(0, QUICK_REPLY_LIMIT);
  const safeIndex = visible.length ? Math.min(activeIndex, visible.length - 1) : 0;

  const resolveVariables = useCallback(
    (body: string) => {
      const atendente = session?.user.name || session?.user.email || "";
      const contato = (contactName ?? "").trim();
      return replaceToken(
        replaceToken(replaceToken(body, "{{nome}}", contato), "{{atendente}}", atendente),
        "{{data}}",
        tenantDate(session?.activeWorkspace?.timezone)
      );
    },
    [session, contactName]
  );

  const selectReply = useCallback(
    (item: QuickReplyItem) => {
      // Substitui o token '/...' pelo corpo da resposta; variáveis viram texto
      // editável (a resolução acontece na inserção, não no envio).
      onReplaceDraft(`${resolveVariables(item.body)} `);
      setActiveIndex(0);
      textareaRef.current?.focus();
    },
    [onReplaceDraft, resolveVariables, textareaRef]
  );

  const handleKey = useCallback(
    (event: ReactKeyboardEvent<Element>): boolean => {
      if (!open) return false;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissedQuery(query);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        // Intercepta ANTES do submit-guard do composer: Enter seleciona e
        // insere, nunca envia — mesmo com a lista ainda carregando ou vazia.
        event.preventDefault();
        event.stopPropagation();
        if (visible.length) selectReply(visible[safeIndex]);
        return true;
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && visible.length) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "ArrowDown") setActiveIndex((index) => (index + 1) % visible.length);
        else setActiveIndex((index) => (index - 1 + visible.length) % visible.length);
        return true;
      }
      return false;
    },
    [open, query, visible, safeIndex, selectReply]
  );

  useImperativeHandle(
    controlRef,
    () => ({ handleKeyDown: handleKey }),
    [handleKey]
  );

  if (!open) return null;

  return (
    <div
      className={styles.anchor}
      data-quick-replies="open"
      data-conversation-id={conversationId}
      onKeyDown={handleKey}
    >
      <div className={styles.popup} role="listbox" aria-label="Sugestões de respostas rápidas">
        <ul className={styles.list} ref={listRef}>
          {visible.map((item, index) => (
            <li key={item.shortcut}>
              <button
                type="button"
                role="option"
                aria-selected={index === safeIndex}
                data-active={index === safeIndex}
                className={styles.option}
                onMouseDown={(event) => {
                  // preventDefault evita roubar o foco do textarea antes de inserir.
                  event.preventDefault();
                  selectReply(item);
                }}
              >
                <span className={styles.optionShortcut}>/{item.shortcut}</span>
                <span className={styles.optionBody}>{item.body}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className={styles.hint}>↑ ↓ navega · Tab ou Enter insere · Esc fecha</p>
      </div>
    </div>
  );
}
