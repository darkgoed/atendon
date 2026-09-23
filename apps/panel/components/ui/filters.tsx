"use client";

import * as RadixPopover from "@radix-ui/react-popover";
import { Funnel, MagnifyingGlass, X } from "@/components/icons";
import { useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Padrão único de filtro (comments.md): chips com [ícone + campo | operador |
 * valor | ×], botão "Filtros" que abre a lista de campos e, dentro dela, a
 * lista de valores com busca, e "Limpar" — como no componente de referência,
 * construído com as primitivas Radix já usadas no painel (Popover/Menu).
 */

export type ListFilterOption = { id: string; nome: string };

export type ListFilterDef<T> = {
  key: keyof T & string;
  label: string;
  icon?: ReactNode;
  /** "option": escolha em lista com busca; "text": valor livre; "date": input de data. */
  kind: "option" | "text" | "date";
  options?: ListFilterOption[];
  /** Operador exibido no chip (ex.: "é", "contém", "depois de"). */
  operator?: string;
  placeholder?: string;
};

type ListFiltersBarProps<T> = {
  filters: T;
  defs: Array<ListFilterDef<T>>;
  /** Grava o valor do filtro (string vazia limpa o filtro). */
  onSet: (key: keyof T & string, value: string) => void;
  onClearAll: () => void;
  label?: string;
};

export function ListFiltersBar<T extends Record<string, string>>({
  filters,
  defs,
  onSet,
  onClearAll,
  label = "Filtros"
}: ListFiltersBarProps<T>) {
  const [addOpen, setAddOpen] = useState(false);
  const [picked, setPicked] = useState<ListFilterDef<T> | null>(null);

  const active = defs
    .filter((def) => (filters[def.key] ?? "").trim() !== "")
    .map((def) => ({ def, value: (filters[def.key] ?? "").trim() }));
  const available = defs.filter((def) => !active.some((item) => item.def.key === def.key));

  const close = () => {
    setAddOpen(false);
    // Aguarda o fechamento do popover antes de resetar a seleção, evitando
    // que o conteúdo mude visivelmente durante a animação de saída.
    window.setTimeout(() => setPicked(null), 200);
  };

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      {active.map(({ def, value }) => (
        <div
          key={def.key}
          className="flex items-center gap-[1px] rounded-sm bg-[var(--surface-active)] text-xs"
          data-active-filter={def.key}
        >
          <span className="flex shrink-0 items-center gap-1.5 rounded-l-sm px-1.5 py-1 text-[var(--text-secondary)]">
            {def.icon}
            {def.label}
          </span>
          <span className="shrink-0 px-1 py-1 text-[var(--text-secondary)]">{def.operator ?? "é"}</span>
          {def.kind === "date" ? (
            <input
              className="mono h-6 w-[8.5rem] bg-transparent px-1 py-0 text-xs text-[var(--text)] outline-none"
              type="date"
              aria-label={`${def.label}: valor`}
              value={value}
              onChange={(event) => onSet(def.key, event.target.value)}
            />
          ) : (
            <PopoverInline<T>
              def={def}
              filters={filters}
              onSet={onSet}
              trigger={def.kind === "text" && value
                ? value
                : optionLabel(def.options, value) ?? value}
            />
          )}
          <button
            type="button"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-r-sm text-[var(--text-muted)] transition hover:text-[var(--primary-text)]"
            onClick={() => onSet(def.key, "")}
            aria-label={`Remover filtro ${def.label}`}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      ))}
      {active.length > 0 ? (
        <button
          type="button"
          className="btn h-6 rounded-sm px-2 text-xs"
          onClick={() => { onClearAll(); setPicked(null); }}
        >
          Limpar
        </button>
      ) : null}
      <RadixPopover.Root
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) close();
        }}
      >
        <RadixPopover.Trigger asChild>
          {/* DS v2 §4: gatilho só-ícone; o rótulo segue como nome acessível e
              title. A contagem de filtros ativos já aparece nos chips ao lado. */}
          <button
            type="button"
            className="btn icon-button icon-button--sm"
            aria-expanded={addOpen}
            aria-haspopup="dialog"
            aria-label={label}
            title={label}
            data-active={active.length > 0 || undefined}
          >
            <Funnel size={14} aria-hidden="true" />
          </button>
        </RadixPopover.Trigger>
        <RadixPopover.Portal>
          <RadixPopover.Content
            align="start"
            sideOffset={6}
            collisionPadding={8}
            className="menu w-[210px]"
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            {picked ? (
              <ValuePicker
                def={picked}
                filters={filters}
                onSet={(key, value) => { onSet(key, value); close(); }}
                onBack={() => setPicked(null)}
              />
            ) : (
              <FieldPicker<T>
                defs={available}
                onPick={(def) => {
                  if (def.kind === "option" && def.options && def.options.length > 0) {
                    setPicked(def);
                  } else if (def.kind === "option") {
                    // Campo sem opções carregadas: nada a escolher.
                    close();
                  } else {
                    setPicked(def);
                  }
                }}
              />
            )}
          </RadixPopover.Content>
        </RadixPopover.Portal>
      </RadixPopover.Root>
    </div>
  );
}

function optionLabel(options: ListFilterOption[] | undefined, value: string): string | null {
  return options?.find((option) => option.id === value)?.nome ?? null;
}

function FieldPicker<T>({ defs, onPick }: { defs: Array<ListFilterDef<T>>; onPick: (def: ListFilterDef<T>) => void }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return defs;
    return defs.filter((def) => def.label.toLowerCase().includes(normalized));
  }, [defs, query]);
  return (
    <>
      <label className="field m-0 mb-1">
        <span className="sr-only">Filtrar campos</span>
        <span className="search-field">
          <MagnifyingGlass size={13} aria-hidden="true" />
          <input
            className="input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={query || "Filtrar..."}
            aria-label="Filtrar campos"
          />
        </span>
      </label>
      <div className="max-h-64 overflow-y-auto" role="listbox" aria-label="Campos de filtro">
        {filtered.map((def) => (
          <button
            key={String(def.key)}
            type="button"
            role="option"
            aria-selected={false}
            className="menu__item"
            onClick={() => onPick(def)}
          >
            {def.icon}
            <span>{def.label}</span>
          </button>
        ))}
        {filtered.length === 0 ? <p className="menu__item m-0">Nenhum campo.</p> : null}
      </div>
    </>
  );
}

function ValuePicker<T extends Record<string, string>>({
  def,
  filters,
  onSet,
  onBack
}: {
  def: ListFilterDef<T>;
  filters: T;
  onSet: (key: keyof T & string, value: string) => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState("");
  if (def.kind === "text") {
    return (
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          onSet(def.key, String(data.get("value") ?? "").trim());
        }}
      >
        <label className="field m-0">
          <span className="label">{def.label}</span>
          <input
            className="input"
            name="value"
            defaultValue={filters[def.key] ?? ""}
            placeholder={def.placeholder}
            autoFocus
          />
        </label>
        <div className="flex gap-1">
          <button type="submit" className="btn primary h-7 flex-1 text-xs">Aplicar</button>
          <button type="button" className="btn h-7 text-xs" onClick={onBack}>Voltar</button>
        </div>
      </form>
    );
  }
  if (def.kind === "date") {
    return (
      <div className="grid gap-2">
        <label className="field m-0">
          <span className="label">{def.label}</span>
          <input
            className="input mono"
            type="date"
            value={filters[def.key] ?? ""}
            autoFocus
            onChange={(event) => onSet(def.key, event.target.value)}
          />
        </label>
        <button type="button" className="btn h-7 text-xs" onClick={onBack}>Voltar</button>
      </div>
    );
  }
  const normalized = query.trim().toLowerCase();
  const options = (def.options ?? []).filter((option) => !normalized || option.nome.toLowerCase().includes(normalized));
  return (
    <>
      <label className="field m-0 mb-1">
        <span className="sr-only">{def.label}</span>
        <span className="search-field">
          <MagnifyingGlass size={13} aria-hidden="true" />
          <input
            className="input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={query || def.label}
            aria-label={`Buscar valor para ${def.label}`}
          />
        </span>
      </label>
      <div className="max-h-64 overflow-y-auto" role="listbox" aria-label={`Valores de ${def.label}`}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="option"
            aria-selected={filters[def.key] === option.id}
            className="menu__item"
            onClick={() => onSet(def.key, option.id)}
          >
            {def.icon}
            <span>{option.nome}</span>
          </button>
        ))}
        {options.length === 0 ? <p className="menu__item m-0">Nenhum resultado.</p> : null}
      </div>
      <button type="button" className="menu__item mt-1" onClick={onBack}>Voltar</button>
    </>
  );
}

function PopoverInline<T extends Record<string, string>>({
  def,
  filters,
  onSet,
  trigger
}: {
  def: ListFilterDef<T>;
  filters: T;
  onSet: (key: keyof T & string, value: string) => void;
  trigger: string;
}) {
  return (
    <RadixPopover.Root>
      <RadixPopover.Trigger asChild>
        <button
          type="button"
          className={cn("max-w-[10rem] shrink-0 truncate rounded-none bg-transparent px-1 py-1 text-xs text-[var(--text)] transition hover:text-[var(--primary-text)]")}
          aria-haspopup="dialog"
          aria-label={`Valor do filtro ${def.label}: ${trigger}`}
        >
          {trigger}
        </button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="menu w-[210px]"
        >
          <ValuePicker def={def} filters={filters} onSet={onSet} onBack={() => undefined} />
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
