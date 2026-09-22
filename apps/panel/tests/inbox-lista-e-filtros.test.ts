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

  it("remove o contador acima da busca e mantém os filtros e as abas", () => {
    expect(conversations).not.toContain("conversation-list__meta");
    expect(conversationsCss).not.toContain(".conversation-list__meta");
    // Absorção do Inbox (F2-r6): o campo ad-hoc "Buscar conversa…" saiu — a
    // busca de conversas agora vive no ListFiltersBar (padrão /contatos) e a
    // busca de entidades é a paleta global (GET /search).
    expect(conversations).not.toContain("Buscar conversa");
    expect(conversations).toContain("ListFiltersBar");
    expect(conversations).toContain("conversation-filter-tabs");
    // O contador de fila do header da tela NÃO é o removido (comments.md L7).
    expect(conversations).toContain("conversation-screen__summary");
  });

  it("elimina a causa raiz do scroll horizontal: item do inbox sem width:100% sob margens", () => {
    // .shell--conversas .conversation-list__item tem margin lateral; w-full
    // (width:100%) somava as margens ao box e vazava 16px no painel.
    expect(shellRailCss).toMatch(/\.shell--conversas \.conversation-list__item \{[^}]*width:\s*auto;/);
    // <button> com width:auto é shrink-to-fit: com linhas nowrap o card
    // explodia além do painel — o wrapper vira coluna flex e o card estica.
    expect(shellRailCss).toMatch(/\.shell--conversas \.conversation-list__items > div \{[^}]*flex-direction:\s*column;/);
  });

  it("cards de dimensões fixas: todas as linhas cortam em 1 linha (ellipsis)", () => {
    // Direção do usuário: cards idênticos — truncar, nunca crescer; nada
    // (nome, @username, última mensagem, status) altera a altura do card.
    expect(conversationsCss).toMatch(/\.conversation-list__name \{[^}]*white-space:\s*nowrap;\s*text-overflow:\s*ellipsis;/);
    expect(conversationsCss).toMatch(/\.conversation-list__company \{[^}]*white-space:\s*nowrap;\s*text-overflow:\s*ellipsis;/);
    expect(conversationsCss).toMatch(/\.conversation-list__preview \{[^}]*white-space:\s*nowrap;\s*text-overflow:\s*ellipsis;/);
    // Altura fixa por linha: prévia em exatamente 1 linha em todos os cards.
    expect(conversationsCss).toMatch(/\.conversation-list__row--title \{[^}]*height:\s*18px;/);
    expect(conversationsCss).toMatch(/\.conversation-list__row--title \{[^}]*justify-content:\s*space-between;/);
    expect(conversationsCss).toMatch(/\.conversation-list__row--identity \{[^}]*height:\s*14px;/);
    expect(conversationsCss).toMatch(/\.conversation-list__row--preview \{[^}]*height:\s*16px;/);
    expect(conversationsCss).toMatch(/\.conversation-list__row--footer \{[^}]*height:\s*16px;/);
    expect(conversationsCss).toMatch(/\.conversation-list__item \{[^}]*overflow:\s*hidden;/);
    // A linha de identidade é sempre renderizada — cards idênticos mesmo
    // sem @username; nada é condicional verticalmente.
    expect(conversations).toContain("conversation-list__row--identity");
    expect(conversations).not.toContain("line-clamp-2");
  });

  it("status não aumenta a altura: chip de IA e rodapé em uma linha", () => {
    expect(conversationsCss).not.toMatch(/\.conversation-list__ai-status \{[^}]*flex-wrap:\s*wrap/);
    expect(conversationsCss).toMatch(/\.conversation-list__ai-status \{[^}]*flex:\s*0 1 auto;/);
    // Próxima ação e etiquetas compartilham a linha do rodapé (truncadas).
    expect(conversations).toContain("conversation-list__info");
    expect(conversations).toContain('singleLine');
  });
});
