"use client";

import { CaretDown, Check, MagnifyingGlass } from "@/components/icons";
import { Tooltip, TooltipProvider } from "@/components/ui";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { workspaceRoleLabel } from "@/lib/labels";
import type { SessionWorkspace } from "@/lib/session";

interface WorkspaceSwitcherProps {
  activeWorkspaceId?: string;
  disabled?: boolean;
  onChange: (workspaceId: string) => void;
  workspaces: SessionWorkspace[];
}

/** A partir de quantas empresas o menu ganha o campo de busca. */
const SEARCH_THRESHOLD = 7;

function initials(name: string) {
  return name.trim().charAt(0).toLocaleUpperCase("pt-BR") || "?";
}

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
}

// Logo do tenant no seletor: quando o workspace tem logo_data, ela substitui a
// inicial (mesmo tamanho, via classe própria + avatar base). Sem logo, o avatar
// com a inicial fica exatamente como antes.
function WorkspaceAvatar({ workspace }: { workspace: SessionWorkspace }) {
  if (workspace.logo_data) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={workspace.logo_data}
        alt=""
        aria-hidden="true"
        className="workspace-switcher__avatar workspace-switcher__avatar-logo"
      />
    );
  }
  return <span className="workspace-switcher__avatar" aria-hidden="true">{initials(workspace.name)}</span>;
}

export function WorkspaceSwitcher({ activeWorkspaceId, disabled = false, onChange, workspaces }: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pendingId, setPendingId] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const menuId = useId();
  const active = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0];
  const searchable = workspaces.length >= SEARCH_THRESHOLD;
  const visible = useMemo(() => {
    const term = normalize(query.trim());
    return term ? workspaces.filter((workspace) => normalize(workspace.name).includes(term)) : workspaces;
  }, [query, workspaces]);
  // A troca recarrega a página: o spinner cobre o intervalo até o reload.
  const switching = disabled && Boolean(pendingId);

  function close(returnFocus = true) {
    setOpen(false);
    setQuery("");
    if (returnFocus) triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!disabled) setPendingId("");
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    // Foco inicial: busca (listas longas) ou a empresa atual.
    const target = searchable ? searchRef.current : optionRefs.current.get(active?.id ?? "");
    target?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [active?.id, open, searchable]);

  if (!active) return null;

  function choose(workspace: SessionWorkspace) {
    close();
    if (workspace.id === active.id) return;
    setPendingId(workspace.id);
    onChange(workspace.id);
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") {
      close(false);
      return;
    }
    const options = visible.map((workspace) => optionRefs.current.get(workspace.id)).filter((node): node is HTMLButtonElement => Boolean(node));
    if (!options.length) return;
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (event.key === "ArrowDown") next = current < 0 ? 0 : Math.min(options.length - 1, current + 1);
    else if (event.key === "ArrowUp") next = current - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    else return;
    event.preventDefault();
    // Subir além da primeira empresa volta para a busca (quando existe).
    if (next < 0) (searchable ? searchRef.current : options[0])?.focus();
    else options[next]?.focus();
  }

  const pendingName = workspaces.find((workspace) => workspace.id === pendingId)?.name;
  const triggerLabel = switching && pendingName
    ? `Trocando para ${pendingName}…`
    : `Empresa atual: ${active.name} (${workspaceRoleLabel(active.role)}). Trocar de empresa`;

  return (
    <TooltipProvider>
      <div className="workspace-switcher" ref={rootRef} data-open={open ? "true" : undefined}>
        <Tooltip content={switching && pendingName ? `Trocando para ${pendingName}…` : <>Empresa: <strong>{active.name}</strong> · clique para trocar</>} side="right">
          <button
            ref={triggerRef}
            type="button"
            className="workspace-switcher__trigger"
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            aria-busy={switching || undefined}
            aria-label={triggerLabel}
            onClick={() => (open ? close() : setOpen(true))}
            onKeyDown={(event) => {
              if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault();
                setOpen(true);
              }
            }}
          >
            <WorkspaceAvatar workspace={active} />
            <span className="workspace-switcher__identity" aria-hidden="true">
              <strong>{active.name}</strong>
              <small>{workspaceRoleLabel(active.role)}</small>
            </span>
            {switching
              ? <span className="on-spinner workspace-switcher__spinner" aria-hidden="true" />
              : <CaretDown size={14} weight="bold" className="workspace-switcher__chevron" aria-hidden="true" />}
          </button>
        </Tooltip>
        {open ? (
          <div className="workspace-switcher__menu" onKeyDown={onMenuKeyDown}>
            <p className="workspace-switcher__heading" aria-hidden="true">Trocar de empresa</p>
            {searchable ? (
              <label className="workspace-switcher__search">
                <MagnifyingGlass size={14} aria-hidden="true" />
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Buscar empresa"
                  aria-label="Buscar empresa"
                  aria-controls={menuId}
                  autoComplete="off"
                />
              </label>
            ) : null}
            <div id={menuId} className="workspace-switcher__list" role="listbox" aria-label="Empresas">
              {visible.map((workspace) => {
                const selected = workspace.id === active.id;
                return (
                  <button
                    key={workspace.id}
                    ref={(node) => {
                      if (node) optionRefs.current.set(workspace.id, node);
                      else optionRefs.current.delete(workspace.id);
                    }}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`workspace-switcher__option${selected ? " active" : ""}`}
                    onClick={() => choose(workspace)}
                  >
                    <WorkspaceAvatar workspace={workspace} />
                    <span>{workspace.name}</span>
                    <small>{workspaceRoleLabel(workspace.role)}</small>
                    {selected ? <Check size={14} className="workspace-switcher__check" aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
            {visible.length === 0 ? <p className="workspace-switcher__empty" role="status">Nenhuma empresa encontrada.</p> : null}
            <p className="workspace-switcher__hint" aria-hidden="true"><kbd>↑↓</kbd> navegar · <kbd>↵</kbd> abrir · <kbd>Esc</kbd> fechar</p>
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
