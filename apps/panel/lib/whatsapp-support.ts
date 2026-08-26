export const WHATSAPP_SUPPORT_PHONE = "5512996062155";
export const WHATSAPP_DISCONNECTED_MESSAGE = "O WhatsApp foi desconectado. Reconecte a sessão para voltar a enviar mensagens.";

const SUPPORT_MESSAGE = "Olá, meu WhatsApp foi desconectado do AtendON e preciso de ajuda para reconectar.";

export function isWhatsAppDisconnectedError(message: string): boolean {
  return /connection closed|whatsapp (?:foi|está) desconectad|sessão (?:do whatsapp )?desconectad/i.test(message);
}

export function friendlyPanelError(message: string): string {
  return isWhatsAppDisconnectedError(message) ? WHATSAPP_DISCONNECTED_MESSAGE : message;
}

export function whatsappReconnectSupportHref(): string {
  return `https://wa.me/${WHATSAPP_SUPPORT_PHONE}?text=${encodeURIComponent(SUPPORT_MESSAGE)}`;
}
