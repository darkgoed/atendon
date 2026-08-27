# Findings — comments.md (rodada 2026-08-26)

## Phase 1 — intenção catalogada

Fonte: /var/www/apps/atendon/comments.md (8 itens não-vazios).

1. **L1 — Bug de exibição.** Em Conversas, mensagens de áudio estão mostrando o
   nome do arquivo (`audio-2026-08-25T12-10-18-804Z`). Intenção: áudio deve
   renderizar só como player, sem o nome técnico do arquivo.

2. **L3 — Bug de UX.** No Pipeline, shift+scroll com o cursor sobre um card não
   rola o board horizontalmente. Intenção: shift+wheel deve rolar horizontal em
   qualquer ponto do board.

3. **L5 — Feature transversal.** Tela de loading por módulo/rota do painel. Sem
   tempo mínimo artificial e sem timeout máximo — o loading dura exatamente o
   tempo do carregamento real.

4. **L7 — Feature.** Botão "Follow-up" ao lado de "Resolver" em Conversas. Ao
   clicar: IA gera e dispara um follow-up contextual imediatamente e o lead cai
   para o estágio follow-up.

5. **L9 — Feature + redesign.** Agenda: adicionar visão mensal; remover scroll
   horizontal (layout fixo); grid de slots; ao clicar num slot, além de
   adicionar lead, poder bloquear horário; bloqueio recorrente (ex.: almoço 12h
   todos os dias) com motivo obrigatório; fidelidade visual ao handoff
   `design_handoff_b2b/CRM Atendimento IA.dc.html` (formato, layout, fonte,
   cores soft).

6. **L11 — Feature.** Follow-up com envio de áudio anexado (ogg/mp3), igual ao
   fluxo de figurinha/imagem. Requisito-chave: o áudio deve chegar como
   mensagem de voz nativa (PTT), não como arquivo baixado/encaminhado.

7. **L13 — Refactor de UI.** Em Leads, as funcionalidades devem virar botões no
   topo (padrão de Conversas/Pipeline/Agenda) em vez de cards/divs próprios. A
   página não pode rolar; só a lista rola internamente.

8. **L15 — Remoção.** Deletar 100%: Melhoria da IA (`/agente/melhorias`) e
   Chaves de API (`/workspace/api-keys`).

9. **L17 — Movimentação.** Figurinhas da IA (`/agente/figurinhas`) passa para um
   novo módulo `/follow-ups`, que reúne os follow-ups e a inserção de imagens,
   vídeos, áudios e figurinhas.

## Ambiguidades resolvidas sem perguntar ao usuário

- comments.md L9 cita `design_handoff_b2b2/` numa parte e `design_handoff_b2b/`
  noutra. Só existe `design_handoff_b2b/` no repo — usado como referência única.
- L11, L15 e L17 se sobrepõem no mesmo módulo (`/follow-ups`) e no mesmo menu de
  navegação, então foram agrupados numa única SPEC para evitar dois agentes
  editando `shell.tsx` ao mesmo tempo.

## Phase 2 — mapeamento (preenchido pelos agentes nas SPECs)

Cada SPEC em `specs/active/` contém a seção `## Affected Areas` com os arquivos
reais investigados. Ver `progress.md` para o mapa item → SPEC.
