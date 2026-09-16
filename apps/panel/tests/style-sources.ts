import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const panelRoot = resolve(__dirname, "..");

/**
 * Lista de stylesheets do design system DERIVADA de app/globals.css.
 *
 * Antes, cada teste que faz asserção sobre CSS mantinha sua própria cópia da
 * lista. Quando um domínio novo entrava em globals.css e não na cópia, os testes
 * passavam lendo uma concatenação desatualizada — uma classe podia ter sido
 * apagada e nada acusava. Derivar da fonte única elimina essa classe de erro.
 */
export const styleFiles: readonly string[] = readFileSync(resolve(panelRoot, "app/globals.css"), "utf8")
  .split("\n")
  .map((line) => /^@import\s+"\.\.\/styles\/(.+?)"/.exec(line)?.[1])
  .filter((file): file is string => Boolean(file));

/** Concatenação de todos os stylesheets, na mesma ordem da cascata real. */
export function readStyleSources(): string {
  return styleFiles.map((file) => readFileSync(resolve(panelRoot, "styles", file), "utf8")).join("\n");
}
