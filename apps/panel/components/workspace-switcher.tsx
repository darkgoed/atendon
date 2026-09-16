"use client";

import { CaretDown } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { SessionWorkspace } from "@/lib/session";

interface WorkspaceSwitcherProps {
  activeWorkspaceId?: string;
  disabled?: boolean;
  onChange: (workspaceId: string) => void;
  workspaces: SessionWorkspace[];
}

function initials(name: string) {
  return name.trim().charAt(0).toLocaleUpperCase("pt-BR") || "?";
}

export function WorkspaceSwitcher({ activeWorkspaceId, disabled = false, onChange, workspaces }: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!active) return null;

  return (
    <div className="workspace-switcher" ref={rootRef}>
      <button
        type="button"
        className="workspace-switcher__trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="workspace-switcher__avatar" aria-hidden="true">{initials(active.name)}</span>
        <span className="workspace-switcher__identity">
          <strong>{active.name}</strong>
          <small>{active.role}</small>
        </span>
        <CaretDown size={14} weight="bold" className="workspace-switcher__chevron" aria-hidden="true" />
      </button>
      {open ? (
        <div className="workspace-switcher__menu" role="listbox" aria-label="Empresas">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              role="option"
              aria-selected={workspace.id === active.id}
              className={`workspace-switcher__option${workspace.id === active.id ? " active" : ""}`}
              onClick={() => {
                setOpen(false);
                if (workspace.id !== active.id) onChange(workspace.id);
              }}
            >
              <span>{workspace.name}</span>
              <small>{workspace.role}</small>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
