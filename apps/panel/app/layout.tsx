// Polyfills e feature detection para navegadores antigos (ver lib/compat.ts)
// rodam antes de todo o resto do painel.
import "@/lib/compat";
import type { Metadata } from "next";
import { AppearanceHydrate } from "@/components/appearance-hydrate";
import { ErrorToasts } from "@/components/error-toasts";
import { PanelAccessGuard } from "@/components/panel-access-guard";
import { PwaBootstrap } from "@/components/pwa-bootstrap";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://atendon.alpdash.com.br"),
  title: { default: "AtendON", template: "%s | AtendON" },
  description: "Painel privado de atendimento e operação do AtendON.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "strict-origin-when-cross-origin"
};

// Aplica tema, sidebar e aparência (accent/densidade, R16) antes da pintura
// para evitar flash. DARK é o padrão do produto: o <html> já sai do servidor
// com data-theme="dark" e o script só troca quando há preferência salva.
// O servidor (GET /me/appearance-preferences) hidrata depois via AppearanceHydrate.
const bootPrefs = `try{var r=document.documentElement;if(localStorage.getItem("atendon-theme")==="light")r.dataset.theme="light";if(localStorage.getItem("atendon-sidebar")==="collapsed")r.dataset.sidebar="collapsed";var a=JSON.parse(localStorage.getItem("atendon-appearance")||"{}");if(a&&typeof a==="object"){if(a.accent)r.dataset.accent=a.accent;if(a.density==="compact")r.dataset.density="compact"}}catch(e){}`;
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR" data-theme="dark" suppressHydrationWarning><body><script dangerouslySetInnerHTML={{ __html: bootPrefs }} /><PwaBootstrap /><AppearanceHydrate /><PanelAccessGuard>{children}</PanelAccessGuard><ErrorToasts/></body></html>;
}
