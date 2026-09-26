import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Contrato da extração para as rotas aninhadas /configuracoes/uso,
// /configuracoes/follow-ups e /configuracoes/alertas: a URL legada (page.tsx)
// permanece default-only e envolve <Shell>; o corpo puro mora no arquivo
// adjacente -content.tsx SEM Shell — a rota nova reusa o corpo sem duplicar
// a sidebar.
const pages = [
  ["uso", "UsoBody"],
  ["follow-ups", "FollowUpsBody"],
  ["alertas", "AlertasBody"]
] as const;

describe("extração do corpo puro para rotas aninhadas /configuracoes", () => {
  for (const [slug, bodyName] of pages) {
    it(`${slug}: page.tsx é wrapper default-only com Shell`, () => {
      const page = readFileSync(join(process.cwd(), `app/${slug}/page.tsx`), "utf8");
      expect(page).toContain(`import { ${bodyName} } from "./${slug}-content";`);
      expect(page).toContain("export default function");
      expect(page).toContain("<Shell>");
    });

    it(`${slug}: ${slug}-content.tsx é corpo puro, sem Shell`, () => {
      const content = readFileSync(join(process.cwd(), `app/${slug}/${slug}-content.tsx`), "utf8");
      expect(content).not.toContain(`from "@/components/shell"`);
      expect(content).not.toContain("<Shell>");
      expect(content).toContain(`export function ${bodyName}`);
    });
  }
});
