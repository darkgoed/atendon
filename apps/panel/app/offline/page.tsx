import Link from "next/link";

export default function OfflinePage() {
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--bg)] p-6 text-[var(--text)]">
      <section className="card max-w-md text-center" aria-labelledby="offline-title">
        <span className="label">ATENDON · OFFLINE</span>
        <h1 id="offline-title" className="mt-3 text-2xl font-semibold">Sem conexão no momento</h1>
        <p className="sub mt-3">Os dados do painel não são armazenados para uso offline. Reconecte-se para validar sua sessão e carregar informações atualizadas.</p>
        <Link className="btn primary mt-6 inline-flex" href="/">Tentar novamente</Link>
      </section>
    </main>
  );
}
