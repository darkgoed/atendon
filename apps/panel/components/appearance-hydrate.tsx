"use client";

import { useEffect } from "react";
import { hydrateAppearance } from "@/lib/appearance";

/**
 * Hidrata as preferências de aparência (accent/densidade) uma vez por carga
 * do painel — chamado aditivamente no layout raiz. Componente nulo: só efeito.
 * Falhas da API são silenciosas dentro de lib/appearance.ts.
 */
export function AppearanceHydrate() {
  useEffect(() => {
    void hydrateAppearance();
  }, []);
  return null;
}