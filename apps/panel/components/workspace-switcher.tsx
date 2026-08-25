"use client";

import type { SessionWorkspace } from "@/lib/session";

interface WorkspaceSwitcherProps {
  activeWorkspaceId?: string;
  disabled?: boolean;
  onChange: (workspaceId: string) => void;
  workspaces: SessionWorkspace[];
}

export function WorkspaceSwitcher({ activeWorkspaceId, disabled = false, onChange, workspaces }: WorkspaceSwitcherProps) {
  return (
    <label className="workspace-switcher">
      <span className="workspace-switcher__label">Workspace</span>
      <select
        className="input workspace-switcher__select"
        value={activeWorkspaceId ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name} · {workspace.role}
          </option>
        ))}
      </select>
    </label>
  );
}
