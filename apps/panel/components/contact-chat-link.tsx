"use client";

import { WhatsappLogo } from "@/components/icons";
import Link from "next/link";

/**
 * Ícone de WhatsApp dos contatos (comments.md): abre a conversa do contato
 * dentro do AtendON (/conversas), tanto para sessões de WhatsApp quanto de
 * Instagram — o backend resolve a conversa certa por telefone ou contato IG.
 * Não renderiza nada quando o contato não tem conversa aberta.
 */
export function ContactChatLink({ conversationId, name, className = "" }: {
  conversationId?: string | null;
  name?: string | null;
  className?: string;
}) {
  if (!conversationId) return null;
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
