import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Termos de uso",
  description: "Termos de uso do AtendON, incluindo o atendimento por WhatsApp e Instagram Direct.",
  alternates: { canonical: "https://atendon.alpdash.com.br/termos" },
  robots: { index: true, follow: true, nocache: false },
  openGraph: {
    type: "website",
    url: "https://atendon.alpdash.com.br/termos",
    title: "Termos de uso | AtendON",
    description: "Termos de uso do AtendON.",
    siteName: "AtendON",
    locale: "pt_BR"
  }
};

export default function TermsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
