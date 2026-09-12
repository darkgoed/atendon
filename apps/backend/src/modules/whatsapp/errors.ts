export class WhatsAppSendRejectedError extends Error {
  readonly sendOutcome = "rejected" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WhatsAppSendRejectedError";
  }
}

export function isWhatsAppSendRejectedError(error: unknown): error is WhatsAppSendRejectedError {
  return error instanceof WhatsAppSendRejectedError && error.sendOutcome === "rejected";
}
