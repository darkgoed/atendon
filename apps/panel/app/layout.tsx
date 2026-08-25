import type { Metadata } from "next";
import { ErrorToasts } from "@/components/error-toasts";
import { PanelAccessGuard } from "@/components/panel-access-guard";
import { PwaBootstrap } from "@/components/pwa-bootstrap";
import "./globals.css";
export const metadata: Metadata = { title: "AtendON", description: "Atendimento IA via WhatsApp" };
// Aplica tema e estado da sidebar antes da pintura para evitar flash.
const bootPrefs = `try{var r=document.documentElement;if(localStorage.getItem("atendon-theme")==="light")r.dataset.theme="light";if(localStorage.getItem("atendon-sidebar")==="collapsed")r.dataset.sidebar="collapsed"}catch(e){}`;
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR" suppressHydrationWarning><body><script dangerouslySetInnerHTML={{ __html: bootPrefs }} /><PwaBootstrap /><PanelAccessGuard>{children}</PanelAccessGuard><ErrorToasts/></body></html>;
}
