export type DestructiveImprovementAction = "publish" | "rollback";

export function requiredImprovementConfirmation(action: DestructiveImprovementAction): string {
  return action === "publish" ? "PUBLICAR" : "REVERTER";
}

export function hasValidImprovementConfirmation(
  action: DestructiveImprovementAction,
  confirmation: string
): boolean {
  return confirmation === requiredImprovementConfirmation(action);
}

export function canPublishImprovementProposal(status: string, publicationEnabled: boolean): boolean {
  return status === "ready" && publicationEnabled;
}

export function resolveImprovementViewState(input: {
  loading: boolean;
  error: string;
  itemCount: number;
}): "loading" | "error" | "empty" | "ready" {
  if (input.loading) return "loading";
  if (input.error) return "error";
  return input.itemCount === 0 ? "empty" : "ready";
}
