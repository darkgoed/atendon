export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailProvider {
  readonly isConfigured: boolean;
  send(message: EmailMessage): Promise<void>;
}
