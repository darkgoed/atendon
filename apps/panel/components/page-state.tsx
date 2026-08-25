import type { ReactNode } from "react";

export function LoadingCards({ label = "Carregando conteúdo" }: { label?: string }) {
  return (
    <div className="grid4" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {[1, 2, 3, 4].map((item) => (
        <div className="card" key={item} aria-hidden="true">
          <div className="skeleton" style={{ height: 14, width: "48%" }} />
          <div className="skeleton" style={{ height: 34, width: "68%", marginTop: 18 }} />
        </div>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty" role="status">{children}</div>;
}
