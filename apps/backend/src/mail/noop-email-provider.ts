import type { Logger } from "pino";
import type { EmailProvider } from "./email-provider.js";

export class NoopEmailProvider implements EmailProvider {
  readonly isConfigured = false;

  constructor(private readonly logger: Logger) {}

  async send(): Promise<void> {
    this.logger.debug("SMTP não configurado; convite não enviado por e-mail");
  }
}
