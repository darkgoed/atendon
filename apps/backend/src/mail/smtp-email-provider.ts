import nodemailer from "nodemailer";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { EmailMessage, EmailProvider } from "./email-provider.js";

export class SmtpEmailProvider implements EmailProvider {
  readonly isConfigured = true;
  private readonly transporter;

  constructor(private readonly appConfig: AppConfig, private readonly logger: Logger) {
    this.transporter = nodemailer.createTransport({
      host: appConfig.SMTP_HOST,
      port: appConfig.SMTP_PORT,
      secure: appConfig.SMTP_SECURE,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      auth: appConfig.SMTP_USER && appConfig.SMTP_PASSWORD
        ? { user: appConfig.SMTP_USER, pass: appConfig.SMTP_PASSWORD }
        : undefined
    });
  }

  async send(message: EmailMessage): Promise<void> {
    try {
      const info = await this.transporter.sendMail({
        from: this.appConfig.SMTP_FROM,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html
      });
      this.logger.info({ messageId: info.messageId }, "Convite enviado por SMTP");
    } catch (error) {
      this.logger.error({ err: error }, "Falha ao enviar convite por SMTP");
      throw error;
    }
  }
}
