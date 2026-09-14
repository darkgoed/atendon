"use client";

import { useEffect } from "react";
import { reportError } from "@/lib/error-events";
import { BrandMark } from "@/components/brand-mark";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => reportError(error.message || "O painel encontrou um erro inesperado"), [error]);
  return (
    <main className="public-state-page">
      <div className="public-state-card" role="alert">
        <div className="public-state-brand"><BrandMark className="brand-logo" /><strong>AtendON</strong></div>
        <h1 className="text-lg font-semibold">Não foi possível carregar esta tela</h1>
        <p className="sub mt-2">O erro foi exibido no aviso do sistema.</p>
        <button className="btn primary mt-5" type="button" onClick={reset}>Tentar novamente</button>
      </div>
    </main>
  );
}
