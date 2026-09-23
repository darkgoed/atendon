import { WhatsappLogo } from "@/components/icons";
import { whatsappReconnectSupportHref } from "../lib/whatsapp-support";


export function WhatsAppDisconnectedHelp() {
  return (
    <a
      className="btn warn mt-3 inline-flex"
      href={whatsappReconnectSupportHref()}
      target="_blank"
      rel="noreferrer"
    >
      <WhatsappLogo size={16} weight="bold" aria-hidden="true" />
      Enviar mensagem para suporte
    </a>
  );
}
