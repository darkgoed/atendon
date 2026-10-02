import type { ReactNode } from "react";

export const ERROR_TOAST_EVENT = "atendon:error";

export type ToastKind = "success" | "info" | "error" | "warning" | "operational";
export type ToastNotice = {
  message: ReactNode;
  kind?: ToastKind;
  duration?: number;
  refresh?: boolean;
  dedupeRemount?: boolean;
  token?: object;
  dismiss?: boolean;
};

export function reportToast(message: ReactNode, options: Omit<ToastNotice, "message" | "dismiss"> = {}): object {
  const token = options.token ?? {};
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<ToastNotice>(ERROR_TOAST_EVENT, { detail: { message, ...options, token } }));
  }
  return token;
}

export function dismissToast(token: object): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<ToastNotice>(ERROR_TOAST_EVENT, { detail: { message: null, token, dismiss: true } }));
  }
}

// A API e o catch local podem encaminhar a mesma falha no mesmo turno.
const reportedThisTurn = new Set<string>();

export function reportError(message: string): void {
  if (typeof window === "undefined" || !message.trim() || reportedThisTurn.has(message)) return;
  reportedThisTurn.add(message);
  globalThis.setTimeout(() => reportedThisTurn.delete(message), 0);
  window.dispatchEvent(new CustomEvent(ERROR_TOAST_EVENT, { detail: { message } }));
}
