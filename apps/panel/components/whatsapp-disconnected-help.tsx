import { WhatsappLogo } from "@phosphor-icons/react";
import { whatsappReconnectSupportHref } from "../lib/whatsapp-support";


export function WhatsAppDisconnectedHelp() {
  return (
    <a
      className="btn mt-3 inline-flex"
      href={whatsappReconnectSupportHref()}
      target="_blank"
      rel="noreferrer"
    >
      <WhatsappLogo size={16} weight="bold" aria-hidden="true" />
      Enviar mensagem para suporte
    </a>
  );
}
