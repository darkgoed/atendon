import { randomBytes } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { EmailProvider } from "./email-provider.js";

export interface WorkspaceInvitationEmailInput {
  recipientEmail: string;
  workspaceName: string;
  roleName: string;
  invitedByEmail: string;
  acceptUrl: string;
  expiresAt: Date;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function formatExpiration(value: Date) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "UTC"
  }).format(value);
}

export function createInvitationToken() {
  return randomBytes(32).toString("base64url");
}

export function buildInvitationAcceptUrl(appConfig: AppConfig, token: string) {
  const url = new URL(appConfig.PANEL_PUBLIC_URL);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/convite`;
  url.searchParams.set("token", token);
  return url.toString();
}

export function shouldExposeInvitationToken(appConfig: AppConfig, emailProvider: EmailProvider) {
  return appConfig.NODE_ENV !== "production" || !emailProvider.isConfigured;
}

export async function sendWorkspaceInvitationEmail(
  emailProvider: EmailProvider,
  input: WorkspaceInvitationEmailInput
) {
  const subject = `Convite para acessar ${input.workspaceName} no AtendON`;
  const expiresAt = formatExpiration(input.expiresAt);
  const workspaceName = escapeHtml(input.workspaceName);
  const roleName = escapeHtml(input.roleName);
  const invitedByEmail = escapeHtml(input.invitedByEmail);
  const acceptUrl = escapeHtml(input.acceptUrl);

  await emailProvider.send({
    to: input.recipientEmail,
    subject,
    text: [
      `Voce recebeu um convite para acessar o workspace ${input.workspaceName} no AtendON.`,
      `Funcao: ${input.roleName}.`,
      `Convite enviado por: ${input.invitedByEmail}.`,
      `Valido ate: ${expiresAt} UTC.`,
      "",
      `Abra este link para concluir o acesso: ${input.acceptUrl}`
    ].join("\n"),
    html: [
      "<p>Voce recebeu um convite para acessar o AtendON.</p>",
      `<p><strong>Workspace:</strong> ${workspaceName}<br/>`,
      `<strong>Funcao:</strong> ${roleName}<br/>`,
      `<strong>Convite enviado por:</strong> ${invitedByEmail}<br/>`,
      `<strong>Valido ate:</strong> ${escapeHtml(expiresAt)} UTC</p>`,
      `<p><a href="${acceptUrl}">Abrir convite</a></p>`
    ].join("")
  });
}
