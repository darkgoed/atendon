"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WhatsappLogo, Compass } from "@phosphor-icons/react";
import { BrandMark } from "@/components/brand-mark";

const SUPPORT_PHONE = "5512996062155";

export default function NotFound() {
  const pathname = usePathname();
  const message = `Encontrei uma página não encontrada (404) no AtendON: ${pathname}`;
  const whatsappHref = `https://wa.me/${SUPPORT_PHONE}?text=${encodeURIComponent(message)}`;

  return (
    <main className="denied-page">
      <div className="denied-card">
        <div className="denied-brand">
          <BrandMark className="brand-logo" />
          <span>AtendON</span>
        </div>
        <div className="denied-icon"><Compass size={28} weight="regular" /></div>
        <div className="eyebrow">Erro 404</div>
        <h1>Não encontramos esta página.</h1>
        <p>O endereço pode ter mudado ou não existe mais. Volte para o painel ou avise o suporte se você chegou aqui a partir de um link do sistema.</p>
        <div className="denied-actions">
          <Link className="btn primary" href="/">Ir para o painel</Link>
          <a className="btn" href={whatsappHref} target="_blank" rel="noreferrer">
            <WhatsappLogo size={16} weight="bold" aria-hidden="true" /> Avisar no WhatsApp
          </a>
        </div>
      </div>
    </main>
  );
}
