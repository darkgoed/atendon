"use client";

import { MagnifyingGlass, type Icon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ModalDialog } from "@/components/modal-dialog";

export type PaletteItem = {
  href: string;
  label: string;
  group: string;
  Icon: Icon;
};

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function CommandPalette({ items, open, onOpenChange }: {
  items: PaletteItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const term = normalize(query.trim());
    if (!term) return items;
    return items.filter((item) => normalize(`${item.group} ${item.label}`).includes(term));
  }, [items, query]);

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
  }, [open]);

  useEffect(() => { setIndex(0); }, [query]);

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
        <h2 id="command-palette-title" className="sr-only">Busca rápida de páginas</h2>
        <div className="cmdk-input">
          <MagnifyingGlass size={16} aria-hidden="true" />
          <input
            data-autofocus
            value={query}
            placeholder="Ir para…"
            aria-label="Buscar página"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); setIndex((i) => Math.min(i + 1, results.length - 1)); }
              if (event.key === "ArrowUp") { event.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
              if (event.key === "Enter" && results[index]) { event.preventDefault(); go(results[index].href); }
            }}
          />
          <kbd>ESC</kbd>
        </div>
        <div ref={listRef} className="cmdk-list" role="listbox" aria-label="Páginas">
          {results.length === 0
            ? <p className="cmdk-empty">Nenhuma página encontrada para “{query}”.</p>
            : results.map((item, i) => (
              <button
                key={item.href}
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
            ))}
        </div>
    </ModalDialog>
  );
}
