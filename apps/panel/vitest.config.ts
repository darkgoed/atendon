import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// O painel usa o alias "@/..." (tsconfig.json -> paths). Sem esta configuração o
// Vitest não resolve o alias e qualquer teste que importe um componente real
// falha com "Cannot find package '@/components/...'". Isso forçava os testes a
// lerem o código-fonte como texto em vez de exercitar o componente.
//
// esbuild.jsx: "automatic" faz o JSX usar o runtime automático do React, do
// mesmo jeito que o Next compila a aplicação. Sem isso, componentes renderizados
// em teste quebram com "ReferenceError: React is not defined", já que nenhum
// componente do repo importa React explicitamente.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url))
    }
  },
  esbuild: {
    jsx: "automatic"
  }
});
