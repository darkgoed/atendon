import type { ReactNode } from "react";

import { Shell } from "@/components/shell";

import { SettingsSidebar } from "./settings-sidebar";

// Layout persistente do hub de configurações: a sidebar sobrevive à navegação
// entre as sub-rotas /configuracoes/* (App Router), sem refetch visual.
export default function ConfiguracoesLayout({ children }: { children: ReactNode }) {
  return (
    <Shell>
      <div className="settings-layout">
        <SettingsSidebar />
        <section className="settings-main">{children}</section>
      </div>
    </Shell>
  );
}
