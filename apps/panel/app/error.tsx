"use client";

import { useEffect } from "react";
import { reportError } from "@/lib/error-events";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => reportError(error.message || "O painel encontrou um erro inesperado"), [error]);
  return (
    <main className="grid min-h-[100dvh] place-items-center p-6">
      <div className="card max-w-md text-center">
        <h1 className="text-lg font-semibold">Não foi possível carregar esta tela</h1>
        <p className="sub mt-2">O erro foi exibido no aviso do sistema.</p>
        <button className="btn primary mt-5" type="button" onClick={reset}>Tentar novamente</button>
      </div>
    </main>
  );
}
