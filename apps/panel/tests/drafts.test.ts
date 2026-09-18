// @vitest-environment jsdom
// R18 — drafts: envelope { data, updated_at } em localStorage com TTL de 6h,
// descarte silencioso de envelope corrompido/vencido e hook useDraft.

import { cleanup, renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearDraft,
  DEFAULT_DRAFT_TTL_MS,
  DRAFT_KEY_PREFIX,
  readDraft,
  useDraft,
  writeDraft
} from "@/lib/drafts";

type IdentityDraft = { nome: string; telefone: string };

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("draft storage primitives", () => {
  it("namespaces the key and persists an envelope with updated_at", () => {
    writeDraft<IdentityDraft>("lead-identity:1", { nome: "Ana", telefone: "11999998888" });
    expect(window.localStorage.getItem(`${DRAFT_KEY_PREFIX}lead-identity:1`)).toContain("\"nome\":\"Ana\"");
    const envelope = readDraft<IdentityDraft>("lead-identity:1");
    expect(envelope?.data.telefone).toBe("11999998888");
    expect(Number.isNaN(Date.parse(envelope?.updated_at ?? ""))).toBe(false);
  });

  it("discards a corrupt envelope silently", () => {
    window.localStorage.setItem(`${DRAFT_KEY_PREFIX}lead-identity:2`, "{not json");
    expect(readDraft("lead-identity:2")).toBeNull();
    expect(window.localStorage.getItem(`${DRAFT_KEY_PREFIX}lead-identity:2`)).toBeNull();
  });

  it("discards an envelope past the 6h TTL (customizable)", () => {
    const now = Date.parse("2026-09-18T12:00:00Z");
    window.localStorage.setItem(
      `${DRAFT_KEY_PREFIX}lead-identity:3`,
      JSON.stringify({ data: { nome: "Ana" }, updated_at: new Date(now - DEFAULT_DRAFT_TTL_MS - 1).toISOString() })
    );
    expect(readDraft("lead-identity:3", { now })).toBeNull();
    expect(window.localStorage.getItem(`${DRAFT_KEY_PREFIX}lead-identity:3`)).toBeNull();

    window.localStorage.setItem(
      `${DRAFT_KEY_PREFIX}lead-identity:4`,
      JSON.stringify({ data: { nome: "Ana" }, updated_at: new Date(now - DEFAULT_DRAFT_TTL_MS + 1_000).toISOString() })
    );
    expect(readDraft("lead-identity:4", { now })).not.toBeNull();

    window.localStorage.setItem(
      `${DRAFT_KEY_PREFIX}lead-identity:5`,
      JSON.stringify({ data: { nome: "Ana" }, updated_at: new Date(now - 2_000).toISOString() })
    );
    expect(readDraft("lead-identity:5", { now, ttlMs: 1_000 })).toBeNull();
  });

  it("returns null without throwing when storage is unavailable", () => {
    const original = window.localStorage;
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => { throw new Error("bloqueado"); } });
    try {
      expect(readDraft("lead-identity:6")).toBeNull();
      expect(() => writeDraft("lead-identity:6", { nome: "x" })).not.toThrow();
      expect(() => clearDraft("lead-identity:6")).not.toThrow();
    } finally {
      Object.defineProperty(window, "localStorage", { configurable: true, value: original });
    }
  });
});

describe("useDraft", () => {
  it("starts empty, saves, exposes the draft and clears", () => {
    const { result } = renderHook(() => useDraft<IdentityDraft>("hook-key"));
    expect(result.current.draft).toBeNull();
    expect(result.current.hasUnsaved).toBe(false);

    act(() => result.current.save({ nome: "Bruno", telefone: "21988887777" }));
    expect(result.current.hasUnsaved).toBe(true);
    expect(result.current.draft?.nome).toBe("Bruno");
    expect(result.current.draftUpdatedAt).not.toBeNull();

    act(() => result.current.clear());
    expect(result.current.hasUnsaved).toBe(false);
    expect(readDraft("hook-key")).toBeNull();
  });

  it("restores the persisted draft after a remount (reload)", () => {
    writeDraft<IdentityDraft>("restore-key", { nome: "Carla", telefone: "31977776666" });
    const first = renderHook(() => useDraft<IdentityDraft>("restore-key"));
    expect(first.result.current.draft?.nome).toBe("Carla");
    expect(first.result.current.hasUnsaved).toBe(true);
    first.unmount();

    const second = renderHook(() => useDraft<IdentityDraft>("restore-key"));
    expect(second.result.current.draft?.telefone).toBe("31977776666");
    act(() => second.result.current.clear());
    expect(second.result.current.hasUnsaved).toBe(false);
  });

  it("suspends reads and writes when disabled", () => {
    writeDraft<IdentityDraft>("disabled-key", { nome: "Duda", telefone: "41966665555" });
    const { result } = renderHook(() => useDraft<IdentityDraft>("disabled-key", { enabled: false }));
    expect(result.current.draft).toBeNull();
    act(() => result.current.save({ nome: "Novo", telefone: "1" }));
    expect(readDraft<IdentityDraft>("disabled-key")?.data.nome).toBe("Duda");
  });
});
