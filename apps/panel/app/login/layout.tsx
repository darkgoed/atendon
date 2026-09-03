import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Entrar no painel",
  description: "Acesso ao painel privado AtendON para equipes com credenciais fornecidas.",
  alternates: { canonical: "/login" },
  robots: { index: true, follow: true, nocache: false },
  openGraph: {
    type: "website",
    url: "https://atendon.alpdash.com.br/login",
    title: "Entrar no painel | AtendON",
    description: "Acesso ao painel privado AtendON para equipes com credenciais fornecidas.",
    siteName: "AtendON",
    locale: "pt_BR"
  },
  twitter: { card: "summary", title: "Entrar no painel | AtendON", description: "Acesso ao painel privado AtendON." }
};

export default function LoginLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
