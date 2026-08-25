import { ApiError } from "./api";

function apiErrorMessage(error: ApiError): string {
  if (error.body && typeof error.body === "object" && "error" in error.body) {
    const message = error.body.error;
    if (typeof message === "string") return message;
  }
  return error.message;
}

export function confirmedFailedSend(error: unknown): boolean {
  return error instanceof ApiError
    && error.status === 409
    && apiErrorMessage(error).startsWith("Envio anterior falhou:");
}

export function definitiveProviderRejection(error: unknown): boolean {
  return error instanceof ApiError
    && error.status === 502
    && /Evolution API recusou a operação \(HTTP 4\d\d\)/.test(apiErrorMessage(error));
}
