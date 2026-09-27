import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "..", "dist");
mkdirSync(dist, { recursive: true });
// CSS vive em src/styles e não passa pelo tsc: copia para dist/styles.
const stylesSrc = join(root, "..", "src", "styles");
if (existsSync(stylesSrc)) {
  cpSync(stylesSrc, join(dist, "styles"), { recursive: true });
}
// Fontes ficam no pacote (assets/fonts) e são lidas por import.meta.url — nada a copiar.
const fonts = join(root, "..", "assets", "fonts");
if (!existsSync(fonts)) throw new Error("assets/fonts ausente");
console.log("assets ok:", readdirSync(fonts).join(", "));
