"use client";

// R18 — Alterações não salvas (drafts). Hook reutilizável sobre localStorage
// (via lib/compat, com feature detection para Safari 12/modo privado), com TTL
// padrão de 6h, chave namespaced e envelope JSON { data, updated_at }.
//
// Regras:
// - Envelope corrompido ou com TTL vencido é descarto silenciosamente (sem
//   console, sem UI): draft é conveniência, nunca fonte de verdade.
// - `save`/`clear` são estáveis por (key, enabled) e seguros para efeitos.
// - A leitura acontece no cliente (effect de mount) para não divergir do SSR.

import { useCallback, useEffect, useState } from "react";
import { safeLocalStorage } from "./compat";

export const DRAFT_KEY_PREFIX = "atendon-draft:v1:";
export const DEFAULT_DRAFT_TTL_MS = 6 * 60 * 60 * 1000;

export type DraftEnvelope<T> = { data: T; updated_at: string };

export type UseDraftOptions = {
  /** TTL do envelope em ms; padrão 6h. */
  ttlMs?: number;
  /** false suspende a leitura/escrita (superfície sem draft ativo). */
  enabled?: boolean;
};

export type UseDraftResult<T> = {
  draft: T | null;
  draftUpdatedAt: string | null;
  hasUnsaved: boolean;
  save: (data: T) => void;
  clear: () => void;
};

function storageKey(key: string): string {
  return `${DRAFT_KEY_PREFIX}${key}`;
}

function parseEnvelope<T>(raw: string): DraftEnvelope<T> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const candidate = parsed as { data?: unknown; updated_at?: unknown };
    if (!("data" in candidate) || typeof candidate.updated_at !== "string") return null;
    return { data: candidate.data as T, updated_at: candidate.updated_at };
  } catch {
    return null;
  }
}

function isExpired(envelope: DraftEnvelope<unknown>, ttlMs: number, now: number): boolean {
  const savedAt = Date.parse(envelope.updated_at);
  if (Number.isNaN(savedAt)) return true;
  return now - savedAt > ttlMs;
}

/** Lê o draft da chave. Corrompido/TTL vencido → descarta e retorna null. */
export function readDraft<T>(key: string, options: { ttlMs?: number; now?: number } = {}): DraftEnvelope<T> | null {
  const store = safeLocalStorage();
  if (!store) return null;
  const namespaced = storageKey(key);
  let raw: string | null = null;
  try {
    raw = store.getItem(namespaced);
  } catch {
    return null;
  }
  if (raw == null) return null;
  const envelope = parseEnvelope<T>(raw);
  if (!envelope || isExpired(envelope, options.ttlMs ?? DEFAULT_DRAFT_TTL_MS, options.now ?? Date.now())) {
    try {
      store.removeItem(namespaced);
    } catch {
      // storage indisponível: nada a limpar
    }
    return null;
  }
  return envelope;
}

/** Persiste o envelope com updated_at agora. Falha de storage é silenciosa. */
export function writeDraft<T>(key: string, data: T, options: { now?: number } = {}): DraftEnvelope<T> {
  const store = safeLocalStorage();
  const envelope: DraftEnvelope<T> = {
    data,
    updated_at: new Date(options.now ?? Date.now()).toISOString()
  };
  if (store) {
    try {
      store.setItem(storageKey(key), JSON.stringify(envelope));
    } catch {
      // Quota/privado: o draft simplesmente não persiste nesta sessão.
    }
  }
  return envelope;
}

/** Remove o draft da chave, se existir. */
export function clearDraft(key: string): void {
  const store = safeLocalStorage();
  if (!store) return;
  try {
    store.removeItem(storageKey(key));
  } catch {
    // storage indisponível: nada a limpar
  }
}

export function useDraft<T>(key: string, options: UseDraftOptions = {}): UseDraftResult<T> {
  const enabled = options.enabled ?? true;
  const ttlMs = options.ttlMs ?? DEFAULT_DRAFT_TTL_MS;
  const [envelope, setEnvelope] = useState<DraftEnvelope<T> | null>(null);

  useEffect(() => {
    setEnvelope(enabled ? readDraft<T>(key, { ttlMs }) : null);
  }, [enabled, key, ttlMs]);

  const save = useCallback(
    (data: T) => {
      if (!enabled) return;
      setEnvelope(writeDraft(key, data));
    },
    [enabled, key]
  );

  const clear = useCallback(() => {
    if (!enabled) return;
    clearDraft(key);
    setEnvelope(null);
  }, [enabled, key]);

  return {
    draft: envelope?.data ?? null,
    draftUpdatedAt: envelope?.updated_at ?? null,
    hasUnsaved: envelope !== null,
    save,
    clear
  };
}
