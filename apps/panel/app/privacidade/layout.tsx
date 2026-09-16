import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Política de privacidade",
  description: "Política de privacidade do AtendON, incluindo o atendimento por Instagram Direct.",
  alternates: { canonical: "https://atendon.alpdash.com.br/privacidade" },
  robots: { index: true, follow: true, nocache: false },
  openGraph: {
    type: "website",
    url: "https://atendon.alpdash.com.br/privacidade",
    title: "Política de privacidade | AtendON",
    description: "Política de privacidade do AtendON.",
    siteName: "AtendON",
    locale: "pt_BR"
  }
};

export default function PrivacyLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
