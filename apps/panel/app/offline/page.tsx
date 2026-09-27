import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";

export default function OfflinePage() {
  return (
    <main className="public-state-page">
      <section className="public-state-card" aria-labelledby="offline-title">
        <div className="public-state-brand"><BrandMark className="brand-logo" /><strong>AtendON</strong></div>
        <span className="label">ATENDON · OFFLINE</span>
        <h1 id="offline-title" className="mt-3 text-xl font-semibold">Sem conexão no momento</h1>
        <p className="sub mt-3">Os dados do painel não são armazenados para uso offline. Reconecte-se para validar sua sessão e carregar informações atualizadas.</p>
        <Link className="btn primary mt-4 inline-flex" href="/">Tentar novamente</Link>
      </section>
    </main>
  );
}
