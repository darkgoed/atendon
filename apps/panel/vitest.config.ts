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
// NÃO defina `test.environment: "jsdom"` globalmente: os testes que leem o
// próprio código-fonte via `readFile(new URL(..., import.meta.url))` quebram com
// "The URL must be of scheme file", porque no ambiente jsdom o import.meta.url
// passa a ser http. Os testes de UI que precisam de DOM devem declarar o
// ambiente por arquivo, com o docblock na PRIMEIRA linha do teste:
//
//   // @vitest-environment jsdom
//
// Com jsdom por arquivo + @testing-library/react (instalados como devDependency
// do painel) dá para exercitar clique e teclado de verdade, em vez de fazer
// assert de string sobre o arquivo-fonte ("teste-teatro").
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
