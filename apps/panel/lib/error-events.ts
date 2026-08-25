export const ERROR_TOAST_EVENT = "atendon:error";

export function reportError(message: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ERROR_TOAST_EVENT, { detail: { message } }));
}
