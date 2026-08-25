import { config } from "../config.js";
import { logger } from "../logger.js";
import type { EmailProvider } from "./email-provider.js";
import { NoopEmailProvider } from "./noop-email-provider.js";
import { SmtpEmailProvider } from "./smtp-email-provider.js";

const defaultProvider = config.SMTP_HOST
  ? new SmtpEmailProvider(config, logger)
  : new NoopEmailProvider(logger);

let providerOverride: EmailProvider | undefined;

export function getEmailProvider() {
  return providerOverride ?? defaultProvider;
}

export function setEmailProviderForTests(provider?: EmailProvider) {
  providerOverride = provider;
}
