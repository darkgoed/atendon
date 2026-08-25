"use client";

import Link from "next/link";
import { ShieldSlash } from "@phosphor-icons/react";
import { BrandMark } from "@/components/brand-mark";

export default function AccessDeniedPage() {
  return (
    <main className="denied-page">
      <div className="denied-card">
        <div className="denied-brand">
          <BrandMark className="brand-logo" />
          <span>AtendON</span>
        </div>
        <div className="denied-icon"><ShieldSlash size={28} weight="regular" /></div>
        <div className="eyebrow">Acesso negado</div>
        <h1>Você não tem permissão para abrir esta área.</h1>
        <p>Troque de workspace, use um perfil com acesso compatível ou volte para uma seção liberada da sua sessão.</p>
        <div className="denied-actions">
          <Link className="btn primary" href="/">Ir para o painel</Link>
          <Link className="btn" href="/login">Entrar com outra conta</Link>
        </div>
      </div>
    </main>
  );
}
