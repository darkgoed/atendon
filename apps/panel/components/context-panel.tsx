"use client";

/**
 * ContextPanel ~300px do /conversas (port visual do shell — SPEC v7, onda 1).
 *
 * Referência 1:1 do donor: coluna de contexto com superfície de card 70% +
 * blur, borda sutil à direita e header com busca global. A LISTA de conversas
 * continua sendo a da página (re-vestida via styles/domains/shell-rail.css,
 * sem reescrita); este componente entrega o chrome do painel:
 *
 *  - `context-panel__backdrop`: coluna fixa ATRÁS do conteúdo (z-index
 *    negativo) — fornece a superfície borrada sobre a qual a lista existente
 *    da página aparece (a coluna da lista fica transparente no domain CSS);
 *  - `context-panel`: header fixo ACIMA do conteúdo com a busca global. A
 *    busca reusa o CommandPalette existente (única busca global do produto —
 *    o port não cria uma segunda).
 *
 * A página /conversas reserva a altura do header na sua coluna de lista
 * (padding-top tokenizado) para que nada fique escondido sob ele.
 */
/* DS v2: a busca global mora na topbar (Conversas.dc.html); o painel de
   contexto mantém só a superfície. `onOpenSearch` segue na assinatura. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- assinatura estável para o Shell
export function ContextPanel(_props: { onOpenSearch?: () => void }) {
  return (
    <>
      <div className="context-panel__backdrop" aria-hidden="true" />
    </>
  );
}
