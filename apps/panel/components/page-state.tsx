import type { ReactNode } from "react";

export function LoadingCards({ label = "Carregando conteúdo" }: { label?: string }) {
  return (
    <div className="grid4" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {[1, 2, 3, 4].map((item) => (
        <div className="card" key={item} aria-hidden="true">
          <div className="loading-cards__line loading-cards__line--wide" />
          <div className="loading-cards__line loading-cards__line--tall" />
        </div>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty" role="status">{children}</div>;
}
