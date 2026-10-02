"use client";

import { WhatsappLogo } from "@/components/icons";
import { IconButton } from "@/components/ui";
import Link from "next/link";

/**
 * Ícone de WhatsApp dos contatos (comments.md): abre a conversa do contato
 * dentro do AtendON (/conversas), tanto para sessões de WhatsApp quanto de
 * Instagram — o backend resolve a conversa certa por telefone ou contato IG.
 * Sem conversa, oferece a ação de início quando o chamador fornece onStart.
 */
export function ContactChatLink({ conversationId, name, className = "", onStart }: {
  conversationId?: string | null;
  name?: string | null;
  className?: string;
  onStart?: () => void;
}) {
  if (!conversationId) return onStart ? (
    <IconButton label="Entrar em contato" size="sm" className={className} onClick={onStart}>
      <WhatsappLogo size={15} weight="bold" aria-hidden="true" />
    </IconButton>
  ) : null;
  return (
    <Link
      className={`btn crm-compact-button justify-center px-2 ${className}`.trim()}
      href={`/conversas?id=${encodeURIComponent(conversationId)}`}
      aria-label={`Conversar com ${name ?? "contato"} pelo WhatsApp`}
      title={`Conversar com ${name ?? "contato"}`}
    >
      <WhatsappLogo size={15} weight="bold" aria-hidden="true" />
    </Link>
  );
}
