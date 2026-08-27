# SPEC: Follow-ups — migrar cadência para /follow-ups e virar card em /configuracoes

## Objective

Consolidar TODA a configuração de follow-up na rota `/follow-ups`, remover a
rota do menu lateral e deixar em `/configuracoes` apenas um card de destino
(padrão Alertas/Conexão/Membros) que leva a `/follow-ups`.

## Source

comments.md L1-92 (bloco da cadência automática + instrução final: "transfira
isso que temos em configurações para o novo /follow-ups e retire ele do menu
lateral, mantenha em configuracoes como modulo iguais: Alertas / Conexão /
Membros").

## Current State

Existem HOJE DUAS UIs de follow-up divergentes:

1. `apps/panel/app/follow-ups/page.tsx:22-40` — UI LEGADA e pobre:
   - `GET /ai-follow-ups/settings` (:23), `GET /ai-follow-ups/media` (:24)
   - cadência num único campo de texto (minutos separados por vírgula)
   - salva com `PATCH /ai-follow-ups/settings` (:33)

2. `apps/panel/app/configuracoes/page.tsx` — UI COMPLETA (a que o usuário quer):
   - montada pelo branch `resource === "follow-ups" → <AiFollowUpSettingsPanel />`
     em `:303-304`
   - cabeçalho "Cadência automática" em `:1526-1528`
   - estado em `:1406-1412` (`AiFollowUpSettings`, `media`, `stickers`)
   - seletor "Formato do envio" em `:1620-1626` com as opções
     `text` / `image` (Imagem + texto) / `sticker` (Figurinha sem texto)
   - salva com `PUT /ai-follow-ups/settings`
   - link hardcoded para `/follow-ups` na mensagem de figurinhas em `:1710`

Helpers compartilhados: `apps/panel/lib/ai-follow-ups.ts`
- `FollowUpDelivery` (:3-6), `AiFollowUpSettings` (:8-15),
  `normalizeFollowUpDelivery` (:17-22), `formatFollowUpDelay` (:24-28),
  `isValidFollowUpDelays` (:30-39 — 1 a 10 tentativas, atrasos inteiros e
  crescentes, de 1 a 43.200 minutos).

Backend:
- `GET /ai-follow-ups/settings` — `apps/backend/src/app.ts:1368-1369`, protegido
  por `requireRootWorkspace`.
- `PUT /ai-follow-ups/settings` — mesmo bloco de app.ts.
- `GET /ai-follow-ups/media`, `GET /ai-stickers` —
  `apps/backend/src/modules/stickers/routes.ts:34-42`.

Cards de destino em /configuracoes: array `settingsDestinations`, renderizado
como `<Link>` com ícone + `<strong>{label}</strong>` + `<small>{description}</small>`.
Destinos atuais: Alertas (`/alertas`), Conexão (`/conexao`), Membros
(`/workspace/members`).

A rota `/configuracoes` mistura DOIS conceitos: os cards de destino
(`settingsDestinations`) e as abas operacionais (`Resource`, `resourceLabels`,
`visibleTabs`, branch de `resource`). O follow-up hoje é uma ABA.

## Desired Behavior

- `/follow-ups` passa a hospedar a UI completa de cadência (a que hoje vive em
  /configuracoes), com todos os recursos: ativar/desativar, tentativas
  cumulativas, formato do envio por tentativa (texto / imagem+texto / figurinha),
  seleção de mídia e figurinha.
- `/configuracoes` não tem mais a aba de follow-ups; tem apenas mais um card de
  destino "Follow-ups", no mesmo padrão de Alertas/Conexão/Membros.
- `/follow-ups` não aparece no menu lateral.
- Nenhuma configuração existente do usuário é perdida na migração.

## Requirements

### R1 — UI completa de cadência vive em /follow-ups

Description: o painel `AiFollowUpSettingsPanel` (hoje embutido em
configuracoes/page.tsx) é extraído para um componente reutilizável e passa a ser
renderizado por `/follow-ups`. A UI legada de `/follow-ups` é substituída.

Acceptance Criteria:
- `/follow-ups` renderiza: toggle Ativo; lista de tentativas cumulativas com
  botão Adicionar/remover; para cada tentativa o atraso em minutos com o rótulo
  legível ("2 hora(s) após a origem") vindo de `formatFollowUpDelay`; o seletor
  "Formato do envio" com as três opções; os seletores de imagem e de figurinha
  quando o formato exigir.
- O texto explicativo "Cada valor é contado desde a resposta original da IA, não
  desde a tentativa anterior." e o rodapé "Alterações também atualizam sequências
  que ainda estão aguardando." estão presentes.
- Salvar usa `PUT /ai-follow-ups/settings` (a rota completa), NUNCA o `PATCH`
  legado.
- O componente extraído é importado tanto por /follow-ups quanto (se ainda
  necessário) por qualquer outro consumidor — sem duplicação de código.
- A validação de `isValidFollowUpDelays` continua aplicada antes de salvar
  (1..10 tentativas, inteiros crescentes, 1..43200 min), com mensagem de erro
  visível ao usuário.

Verification: teste de UI renderizando /follow-ups; inspeção de que
`PATCH /ai-follow-ups/settings` não é mais chamado pelo painel.

### R2 — /configuracoes perde a aba e ganha o card

Description: remover `follow-ups` de `Resource`, `resourceLabels`, `visibleTabs`
e do branch de renderização em configuracoes/page.tsx; adicionar uma entrada em
`settingsDestinations`.

Acceptance Criteria:
- Não existe mais aba/abas de follow-up em /configuracoes.
- `settingsDestinations` contém uma entrada Follow-ups com `href="/follow-ups"`,
  ícone, label e descrição curta, renderizada exatamente com o mesmo componente
  e as mesmas classes de Alertas/Conexão/Membros — nenhum estilo novo.
- Acessar `/configuracoes?resource=follow-ups` NÃO quebra: redireciona para
  `/follow-ups` ou cai no recurso padrão sem erro de runtime.
- Nenhum import fica órfão (o build roda `eslint --max-warnings=0`).

Verification: `npx eslint app/configuracoes/page.tsx --max-warnings=0` → 0;
teste de UI conferindo o card e a ausência da aba.

### R3 — /follow-ups fora do menu lateral

Description: remover a entrada de `/follow-ups` da navegação lateral.

Acceptance Criteria:
- `apps/panel/components/shell.tsx` não declara nenhum item de navegação
  apontando para `/follow-ups`.
- A rota continua acessível por URL direta e pelo card de /configuracoes.
- Nenhum outro item do menu é removido ou reordenado.

Verification: `grep -n "follow-ups" apps/panel/components/shell.tsx` → vazio;
teste que renderiza o Shell e afirma a ausência do link.

### R4 — Permissões preservadas

Description: o acesso a /follow-ups exige o mesmo nível que hoje protege a aba
em /configuracoes.

Acceptance Criteria:
- Os endpoints continuam exigindo `requireRootWorkspace` (app.ts:1369) — nenhuma
  permissão é afrouxada.
- Um usuário sem acesso não vê o card em /configuracoes e, ao acessar
  /follow-ups direto, recebe o mesmo tratamento de negação já usado no painel
  (não uma tela quebrada).

Verification: teste renderizando com sessão sem permissão.

### R5 — Nenhuma perda de configuração

Description: a migração é apenas de UI. O contrato de dados não muda.

Acceptance Criteria:
- Nenhuma migration de banco é criada para esta SPEC.
- O payload enviado pelo `PUT` é idêntico ao que a UI de /configuracoes já
  enviava.
- Após a mudança, abrir /follow-ups mostra os valores já salvos do tenant.

Verification: comparação do payload antes/depois; teste de serialização.

## Invariants

- Design idêntico: mesmas classes, cores, fontes e espaçamentos. É mudança de
  lugar, não redesign.
- O link de figurinhas (configuracoes/page.tsx:1710) continua válido — se ficar
  redundante dentro da própria página, ajustar o texto, não quebrar o link.
- Nenhum endpoint novo é criado.

## Edge Cases

- Tenant sem nenhuma mídia/figurinha cadastrada → opções `image`/`sticker`
  permanecem desabilitadas (comportamento atual já em :1623-1624).
- Deep link `/configuracoes?resource=follow-ups` (R2).
- Sequências de follow-up já aguardando: o rodapé afirma que alterações as
  atualizam — comportamento do backend não muda.

## Dependencies

Nenhuma. Deve ser implementada ANTES da SPEC de responsividade tocar
configuracoes/page.tsx (conflito de arquivo).

## Affected Areas

- apps/panel/app/follow-ups/page.tsx
- apps/panel/app/configuracoes/page.tsx
- novo: apps/panel/components/ai-follow-up-settings-panel.tsx (extração)
- apps/panel/components/shell.tsx
- apps/panel/lib/ai-follow-ups.ts (somente se precisar exportar algo)

## Non-goals

- Alterar o backend de follow-ups.
- Mudar a lógica de cadência/IA.
- Redesenhar /configuracoes.

## Constraints

- `configuracoes/page.tsx` e `shell.tsx` são disputados por outras SPECs desta
  rodada — esta SPEC roda em onda exclusiva sobre esses arquivos.
- Build do painel roda `eslint --max-warnings=0`.

## Required Tests

- `apps/panel/tests/follow-ups-page.test.tsx`: renderiza /follow-ups com mock de
  API e verifica presença do toggle, da lista de tentativas e do seletor de
  formato com as 3 opções; verifica que o submit chama `PUT`.
- Teste que afirma ausência de `/follow-ups` na navegação do Shell.
- Teste que afirma presença do card em /configuracoes e ausência da aba.
- Testes importam o código de produção — proibida asserção de string sobre o
  arquivo-fonte.

## Definition of Done

- [ ] R1..R5 atendidos e verificados
- [ ] `npx tsc --noEmit` (painel) 0 erros
- [ ] `npx vitest run` (painel) exit 0
- [ ] `npx eslint app/configuracoes app/follow-ups components/shell.tsx --max-warnings=0` → 0
- [ ] `grep "follow-ups" components/shell.tsx` → vazio
- [ ] Nenhuma migration criada
