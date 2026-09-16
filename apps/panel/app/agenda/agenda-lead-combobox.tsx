"use client";

import { Check, MagnifyingGlass, X } from "@phosphor-icons/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { formatBrazilianPhone } from "@/lib/phone";
import type { AppointmentLead } from "./agenda-types";

type AppointmentLeadsResponse = { leads: AppointmentLead[] };
const leadFetcher = (url: string) => api<AppointmentLeadsResponse>(url);

function leadLabel(lead: AppointmentLead) {
  const phone = formatBrazilianPhone(lead.telefone);
  return lead.nome?.trim() ? `${lead.nome.trim()} · ${phone}` : phone;
}

export function AgendaLeadCombobox({ selected, disabled, onSelect }: {
  selected: AppointmentLead | null;
  disabled?: boolean;
  onSelect: (lead: AppointmentLead | null) => void;
}) {
  const inputId = useId();
  const listboxId = `${inputId}-results`;
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => () => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
  }, []);

  const key = !selected && debouncedQuery.length > 0
    ? `/scheduling/appointment-leads?busca=${encodeURIComponent(debouncedQuery)}&limit=20`
    : null;
  const { data, error, isLoading, mutate } = useSWR<AppointmentLeadsResponse>(key, leadFetcher, {
    keepPreviousData: false,
    revalidateOnFocus: false,
    shouldRetryOnError: false
  });
  const leads = useMemo(() => data?.leads ?? [], [data?.leads]);
  const showResults = open && !selected && query.trim().length > 0;

  function choose(lead: AppointmentLead) {
    onSelect(lead);
    setQuery(leadLabel(lead));
    setOpen(false);
    setActiveIndex(0);
  }

  return (
    <div className="agenda-lead-combobox field relative">
      <label className="label" htmlFor={inputId}>Lead</label>
      <div className="relative">
        <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" size={17} aria-hidden="true" />
        <input
          id={inputId}
          data-autofocus
          className="input w-full pl-10 pr-10"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showResults}
          aria-controls={listboxId}
          aria-activedescendant={showResults && leads[activeIndex] ? `${listboxId}-${leads[activeIndex].id}` : undefined}
          autoComplete="off"
          value={selected ? leadLabel(selected) : query}
          disabled={disabled}
          placeholder="Busque por nome ou número"
          onFocus={() => { if (!selected) setOpen(true); }}
          onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 120); }}
          onChange={(event) => {
            if (selected) onSelect(null);
            setQuery(event.target.value);
            setOpen(true);
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              return;
            }
            if (!showResults || leads.length === 0) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((current) => (current + 1) % leads.length);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((current) => (current - 1 + leads.length) % leads.length);
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(leads[activeIndex]);
            }
          }}
        />
        {selected ? (
          <Button className="agenda-lead-combobox__clear absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded" aria-label="Limpar lead selecionado" disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => { onSelect(null); setQuery(""); setOpen(true); }}>
            <X size={15} aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {showResults ? (
        <div id={listboxId} role="listbox" aria-label="Resultados de leads" className="agenda-lead-combobox__results absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1">
          {query.trim() !== debouncedQuery ? <p className="px-3 py-3 text-sm text-[var(--text-secondary)]" role="status">Buscando…</p> : null}
          {query.trim() === debouncedQuery && isLoading ? <p className="px-3 py-3 text-sm text-[var(--text-secondary)]" role="status">Buscando leads…</p> : null}
          {query.trim() === debouncedQuery && error ? (
            <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm text-[var(--warning-text)]" role="alert">
              <span>Não foi possível buscar leads.</span>
              <button type="button" className="btn warn" onMouseDown={(event) => event.preventDefault()} onClick={() => void mutate()}>Tentar novamente</button>
            </div>
          ) : null}
          {query.trim() === debouncedQuery && !isLoading && !error && leads.length === 0 ? <p className="px-3 py-3 text-sm text-[var(--text-secondary)]" role="status">Nenhum lead encontrado.</p> : null}
          {query.trim() === debouncedQuery && !isLoading && !error ? leads.map((lead, index) => (
            <button
              id={`${listboxId}-${lead.id}`}
              key={lead.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`agenda-lead-combobox__option flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm ${index === activeIndex ? "is-active" : ""}`}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(lead)}
            >
              <span className="min-w-0"><strong className="block truncate">{lead.nome?.trim() || "Sem nome"}</strong><span className="mono text-xs text-[var(--text-secondary)]">{formatBrazilianPhone(lead.telefone)}</span></span>
              {index === activeIndex ? <Check className="shrink-0" size={16} aria-hidden="true" /> : null}
            </button>
          )) : null}
        </div>
      ) : null}
      <small className="sub">Digite um nome ou número para buscar. Nenhum lead é carregado antes da pesquisa.</small>
    </div>
  );
}
