"use client";

import { ChatsCircle, ListChecks, MagnifyingGlass, UsersThree, type Icon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModalDialog } from "@/components/modal-dialog";
import { api } from "@/lib/api";

export type PaletteItem = {
  href: string;
  label: string;
  group: string;
  Icon: Icon;
};

type SearchItem = {
  id: string;
  name?: string;
  title?: string;
  contact_name?: string | null;
  contact_phone?: string | null;
  status?: string;
  priority?: string;
  created_at?: string;
};

// Contrato de GET /search (apps/backend/src/modules/search/): q trim min 2 max
// 100, limit 1..25 (default 8), cursor opaco. Seções sem permissão vêm
// OMITIDAS (contacts) ou VAZIAS (tasks/conversations) — o FE apenas itera as
// seções presentes e oculta as vazias; nunca replica RBAC.
type SearchSection = {
  items: SearchItem[];
  page: { has_more: boolean; next_cursor: string | null };
};

type SearchResponse = {
  q: string;
  page: { limit: number; has_more: boolean; next_cursor: string | null };
  contacts?: SearchSection;
  tasks?: SearchSection;
  conversations?: SearchSection;
};

type EntityResult = { key: string; href: string; label: string; group: string; Icon: Icon };

const SEARCH_LIMIT = 8;
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_MIN_CHARS = 2;

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

type SearchSectionName = "contacts" | "tasks" | "conversations";

function itemLabel(item: SearchItem, section: SearchSectionName) {
  if (section === "contacts") return item.name?.trim() || item.contact_phone || "Contato";
  if (section === "tasks") return item.title?.trim() || "Tarefa";
  return item.contact_name?.trim() || item.contact_phone || "Conversa";
}

function sectionHref(section: SearchSectionName, item: SearchItem) {
  // Deep-links sem rota nova (SPEC settings-search R5): conversa reutiliza o
  // ?id= existente; contato/tarefa vão para os destinos existentes.
  if (section === "conversations") return `/conversas?id=${encodeURIComponent(item.id)}`;
  if (section === "tasks") return "/tarefas";
  return "/contatos";
}

const SECTION_META: Array<{ section: SearchSectionName; label: string; Icon: Icon }> = [
  { section: "contacts", label: "Contatos", Icon: UsersThree },
  { section: "tasks", label: "Tarefas", Icon: ListChecks },
  { section: "conversations", label: "Conversas", Icon: ChatsCircle }
];

function mergeSection(previous: SearchSection | undefined, next: SearchSection | undefined): SearchSection | undefined {
  if (!next) return previous;
  const seen = new Set((previous?.items ?? []).map((item) => item.id));
  return {
    items: [...(previous?.items ?? []), ...next.items.filter((item) => !seen.has(item.id))],
    page: next.page
  };
}

const EMPTY_SEARCH: SearchResponse = { q: "", page: { limit: SEARCH_LIMIT, has_more: false, next_cursor: null } };

export function CommandPalette({ items, open, onOpenChange, workspaceId }: {
  items: PaletteItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId?: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [result, setResult] = useState<{ q: string; response: SearchResponse } | null>(null);
  const [searching, setSearching] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  // Cache de resultados POR WORKSPACE: a chave inclui o tenant ativo e a troca
  // de workspace aborta requisições em voo, limpa o cache e o estado — uma
  // resposta do tenant anterior nunca renderiza (SPEC settings-search R5).
  const cacheRef = useRef<{ workspaceId: string | undefined; byQuery: Map<string, SearchResponse> }>({ workspaceId, byQuery: new Map() });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
        return;
      }
      if (open && event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    setResult(null);
    setSearching(false);
  }, [open]);

  // Troca de workspace: aborta o que estiver em voo, zera cache e resultados.
  // O cursor de um tenant é inválido no outro — é descartado junto.
  useEffect(() => {
    if (cacheRef.current.workspaceId === workspaceId) return;
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    cacheRef.current = { workspaceId, byQuery: new Map() };
    setResult(null);
    setSearching(false);
  }, [workspaceId]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed.length < SEARCH_MIN_CHARS) {
      setSearching(false);
      return;
    }
    const timer = window.setTimeout(() => {
      const cached = cacheRef.current.byQuery.get(trimmed);
      if (cached) {
        setResult({ q: trimmed, response: cached });
        setSearching(false);
        return;
      }
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      setSearching(true);
      api<SearchResponse>(
        `/search?q=${encodeURIComponent(trimmed)}&limit=${SEARCH_LIMIT}`,
        { signal: controller.signal },
        { reportErrors: false }
      )
        .then((response) => {
          if (controller.signal.aborted) return;
          cacheRef.current.byQuery.set(trimmed, response);
          setResult({ q: trimmed, response });
        })
        .catch(() => {
          // Falha de rede ou 400 (cursor/validação): estado vazio, sem travar.
          if (controller.signal.aborted) return;
          setResult({ q: trimmed, response: { ...EMPTY_SEARCH, q: trimmed } });
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      // Nova busca (ou fechar o modal) cancela a requisição anterior.
      searchAbortRef.current?.abort();
    };
  }, [open, query, workspaceId]);

  const loadMore = useCallback(() => {
    const cursor = result?.response.page.next_cursor;
    if (!result || !cursor || searching) return;
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearching(true);
    api<SearchResponse>(
      `/search?q=${encodeURIComponent(result.q)}&limit=${SEARCH_LIMIT}&cursor=${encodeURIComponent(cursor)}`,
      { signal: controller.signal },
      { reportErrors: false }
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        // Cursor opaco repassado intacto; o backend pagina por keyset.
        const merged: SearchResponse = {
          q: response.q,
          page: response.page,
          contacts: mergeSection(result.response.contacts, response.contacts),
          tasks: mergeSection(result.response.tasks, response.tasks),
          conversations: mergeSection(result.response.conversations, response.conversations)
        };
        cacheRef.current.byQuery.set(result.q, merged);
        setResult({ q: result.q, response: merged });
      })
      .catch(() => {
        // Cursor expirado/inválido (400): mantém a página atual, sem travar.
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false);
      });
  }, [result, searching]);

  useEffect(() => { setIndex(0); }, [query]);

  const trimmedQuery = query.trim();
  const pageResults = useMemo(() => {
    const term = normalize(trimmedQuery);
    if (!term) return items;
    return items.filter((item) => normalize(`${item.group} ${item.label}`).includes(term));
  }, [items, trimmedQuery]);

  const entityResults = useMemo<EntityResult[]>(() => {
    // Só renderiza a resposta da consulta ATUAL e apenas com q >= 2: resultado
    // de consulta antiga (ou do tenant anterior) nunca vira lista.
    if (trimmedQuery.length < SEARCH_MIN_CHARS || !result || result.q !== trimmedQuery) return [];
    return SECTION_META.flatMap(({ section, label, Icon }) => {
      const sectionData = result.response[section];
      if (!sectionData) return []; // seção omitida (sem permissão) → oculta
      return sectionData.items.map((item) => ({
        key: `${section}:${item.id}`,
        href: sectionHref(section, item),
        label: itemLabel(item, section),
        group: label,
        Icon
      }));
    });
  }, [result, trimmedQuery]);

  const results = useMemo(() => ([
    ...pageResults.map((item, i) => ({ ...item, key: `page:${item.href}:${i}` })),
    ...entityResults
  ]), [pageResults, entityResults]);

  const hasMore = Boolean(result && result.q === trimmedQuery && result.response.page.has_more && result.response.page.next_cursor);
  const hasResults = results.length > 0;

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index, results]);

  if (!open) return null;

  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };

  return (
    <ModalDialog
      overlayClassName="cmdk-overlay"
      dialogClassName="cmdk"
      labelledBy="command-palette-title"
      onClose={() => onOpenChange(false)}
    >
        <h2 id="command-palette-title" className="sr-only">Busca global</h2>
        <div className="cmdk-input">
          <MagnifyingGlass size={16} aria-hidden="true" />
          <input
            data-autofocus
            value={query}
            placeholder="Buscar páginas, contatos, tarefas e conversas…"
            aria-label="Buscar"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); setIndex((i) => Math.min(i + 1, results.length - 1)); }
              if (event.key === "ArrowUp") { event.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
              if (event.key === "Enter" && results[index]) { event.preventDefault(); go(results[index].href); }
            }}
          />
          <kbd>ESC</kbd>
        </div>
        <div ref={listRef} className="cmdk-list" role="listbox" aria-label="Resultados da busca">
          {trimmedQuery.length < SEARCH_MIN_CHARS && !hasResults
            ? <p className="cmdk-empty">Digite ao menos {SEARCH_MIN_CHARS} letras para buscar contatos, tarefas e conversas — ou navegue pelas páginas abaixo.</p>
            : null}
          {trimmedQuery.length >= SEARCH_MIN_CHARS && searching && !hasResults
            ? <p className="cmdk-empty" role="status">Buscando…</p>
            : null}
          {trimmedQuery.length >= SEARCH_MIN_CHARS && !searching && !hasResults
            ? <p className="cmdk-empty">Nada encontrado para “{trimmedQuery}”.</p>
            : null}
          {hasResults
            ? results.map((item, i) => (
              <button
                key={item.key}
                type="button"
                role="option"
                aria-selected={i === index}
                className={`cmdk-item${i === index ? " active" : ""}`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => go(item.href)}
              >
                <item.Icon size={16} aria-hidden="true" />
                <span>{item.label}</span>
                <small>{item.group}</small>
              </button>
            ))
            : null}
          {hasMore ? (
            <button type="button" className="cmdk-item" onClick={loadMore} disabled={searching}>
              <MagnifyingGlass size={16} aria-hidden="true" />
              <span>{searching ? "Carregando…" : "Carregar mais"}</span>
            </button>
          ) : null}
        </div>
        <div className="cmdk-footer" aria-hidden="true">
          <span><kbd>↑↓</kbd>navegar</span>
          <span><kbd>↵</kbd>abrir</span>
          <span>Ctrl K</span>
        </div>
    </ModalDialog>
  );
}
