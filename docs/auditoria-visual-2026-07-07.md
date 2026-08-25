# Auditoria visual — 2026-07-07

Auditoria de UI/UX do painel (`apps/panel`) feita em loop com 4 subagentes (Haiku) divididos por grupos de páginas, seguida de verificação manual dos achados e correções mínimas. Cada ciclo terminou com `typecheck` + `vitest` + `next build` verdes (22 rotas).

## Correções aplicadas

### Design system (`app/globals.css`)
1. **`.label` duplicado** — duas declarações conflitantes (12.5px vs mono 10px uppercase); unificado em uma regra preservando o estilo efetivo.
2. **Eyebrow do `.pagehead` fixo** — `::before` imprimia "PAINEL · CONFIGURAÇÃO" em todas as páginas; agora usa `content: var(--eyebrow, "PAINEL · CONFIGURAÇÃO")`, com valor por página (referência de design usa "PAINEL · HOJE" no dashboard).
3. **Token `--warn-muted: #9a8a68`** — cor repetida hardcoded em 3 páginas; tokenizada.
4. **Overflow de UUIDs/slugs/e-mails** — nova regra `.admin-table td .sub, .invitation-summary strong { overflow-wrap:anywhere }`.
5. **Arquivo órfão removido** — `globals.sync-conflict-20260706-050357-YWCTVQP.css` (artefato Syncthing de tema antigo, não referenciado).

### Eyebrows por página
- `/` → PAINEL · HOJE · `/leads`, `/leads/[id]`, `/agenda` → PAINEL · ATENDIMENTO · `/uso` → PAINEL · MONITORAMENTO · `/perfil` → PAINEL · CONTA · `/root/*` → PAINEL · ROOT · páginas de configuração mantêm o padrão.

### Estados de loading (antes mostravam empty/zeros durante fetch)
6. **`/leads`** — skeleton na tabela + contador "carregando…".
7. **`/root/users`**, **`/workspace/audit`** — `LoadingCards` antes das métricas/tabela.
8. **`/root/audit`** — `LoadingCards` antes da tabela.
9. **`/root/workspaces`** — skeleton no catálogo (form permanece visível).
10. **`/workspace/roles`** — skeleton na lista de funções.
11. **`/configuracoes`** — estado `loading` novo; skeleton na tabela.
12. **`/agenda`** — flag `unitsLoaded`; skeleton em vez de "Cadastre uma unidade" durante o load.
13. **`/humanizacao`** — "Carregando…" plano → `.skeleton h-96` (padrão do agente).
14. **`/conversas`** — skeletons da lista e da thread ganharam a classe `.skeleton` (shimmer).
15. **`/invitations/[token]`** — "Carregando convite..." → skeleton.

### Estados de ação (pending/disabled)
16. **`/conversas`** — "Reativar IA" e enviar mensagem agora desabilitam durante o request (evita duplo clique); texto "Reativando…".
17. **`/humanizacao`** — botão salvar desabilita + "Salvando…" durante submit.
18. **`/agente`** — botão salvar mostra "Salvando…" (já desabilitava).

### Cores e consistência
19. **`/` (dashboard)** — status do agente "Pausado" agora usa `.warning` (antes sempre `.accent`); `#9a8a68` → `var(--warn-muted)`.
20. **`/conexao`** — badge de status inativo usava `border-[#4a3a1c]` (divergente do token `--warn-border` #49371c); alinhado ao token; `#9a8a68` → token.
21. **`/conversas`** — `#9a8a68` → token; layout mobile do chat: grid ganhou `grid-rows-[minmax(0,42dvh)_minmax(0,1fr)]` (antes a lista empurrava a thread para fora do `overflow-hidden` em <1024px).
22. **`/configuracoes`** — título "Configuração" divergia do rótulo "Catálogo" no menu lateral; h1 renomeado para "Catálogo".
23. **Busca de auditoria** (`/root/audit`, `/workspace/audit`) — `.search-field` reservava 38px para ícone que não existia; adicionada a lupa (padrão de `/leads`).

### Infra
24. **`npm install`** — dependência `swr` estava declarada mas não instalada; typecheck de baseline falhava antes de qualquer mudança.

## Achados descartados (falsos positivos / intencionais)
- "Classes Tailwind inexistentes" — Tailwind v4 está ativo via `@import "tailwindcss"`; utilities são válidas.
- `.accent`/`.warning` no dashboard — classes existem no globals.css.
- Tabela de leads "sem overflow" — o wrapper já tem `overflow-x-auto`.
- QR code com cores fixas — contraste necessário para leitura.
- `#53bdeb` nos ticks de mensagem — convenção visual do WhatsApp.
- Gradientes dos balões de chat e paleta do gráfico de Uso — decisões de design legítimas.
- Sugestões de consolidar Tailwind em classes novas — refatoração fora do escopo (mudanças mínimas, sem alterar regra de negócio).

## Verificação
- `npm run typecheck -w @atendon/panel` ✓
- `npm test -w @atendon/panel` ✓ (3/3)
- `npm run build -w @atendon/panel` ✓ (22 rotas)
