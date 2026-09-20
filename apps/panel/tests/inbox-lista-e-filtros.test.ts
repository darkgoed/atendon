import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

let conversations = "";
let conversationsCss = "";
let shellRailCss = "";

beforeAll(async () => {
  [conversations, conversationsCss, shellRailCss] = await Promise.all([
    readFile(new URL("../app/conversas/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../styles/domains/conversations.css", import.meta.url), "utf8"),
    readFile(new URL("../styles/domains/shell-rail.css", import.meta.url), "utf8")
  ]);
});

describe("inbox /conversas — comments.md L5, L7, L9", () => {
  it("usa ListFiltersBar (o mesmo filtro de /contatos) e não o painel ad-hoc antigo", () => {
    expect(conversations).toContain("ListFiltersBar");
    expect(conversations).not.toContain("advancedFiltersOpen");
    expect(conversations).not.toContain("Filtros avançados");
    // O padrão é o mesmo componente de /contatos e /pipeline.
    expect(conversations).toContain('from "@/components/ui/filters"');
  });

  it("remove o contador acima da busca e mantém a busca e as abas", () => {
    expect(conversations).not.toContain("conversation-list__meta");
    expect(conversationsCss).not.toContain(".conversation-list__meta");
    expect(conversations).toContain("Buscar conversa por nome ou telefone");
    expect(conversations).toContain("conversation-filter-tabs");
    // O contador de fila do header da tela NÃO é o removido (comments.md L7).
    expect(conversations).toContain("conversation-screen__summary");
  });

  it("elimina a causa raiz do scroll horizontal: item do inbox sem width:100% sob margens", () => {
    // .shell--conversas .conversation-list__item tem margin lateral; w-full
    // (width:100%) somava as margens ao box e vazava 16px no painel.
    expect(shellRailCss).toMatch(/\.shell--conversas \.conversation-list__item \{[^}]*width:\s*auto;/);
  });

  it("identificadores mono quebram linha em vez de cortar (cortar nada)", () => {
    expect(conversationsCss).toMatch(/\.conversation-list__company \{[^}]*overflow-wrap:\s*anywhere;/);
    expect(conversations).not.toContain("conversation-list__company mono truncate");
  });
});
