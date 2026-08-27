export function pipelineViewStorageKey(workspaceId: string, userId: string) {
  return `atendon.pipeline.view:${workspaceId}:${userId}`;
}

export function readPipelineViewPreference(workspaceId: string, userId: string): "kanban" | "list" | null {
  const stored = window.localStorage.getItem(pipelineViewStorageKey(workspaceId, userId));
  return stored === "list" || stored === "kanban" ? stored : null;
}

export function writePipelineViewPreference(workspaceId: string, userId: string, mode: "kanban" | "list") {
  window.localStorage.setItem(pipelineViewStorageKey(workspaceId, userId), mode);
}
