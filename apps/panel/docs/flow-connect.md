# FlowConnect — pattern "fluxo conectado"

Componente do design system do painel: blocos (cards) ligados por **setas
discretas** representando uma relação de sequência/fluxo entre etapas.
Não é wizard, não tem numeração, não obriga ordem de interação — é apenas
**hierarquia visual de leitura**.

Arquivos:

- `components/flow-connect.tsx` (client component)
- `components/flow-connect.module.css`

## API

```tsx
import { FlowConnect, type FlowConnectItem } from "@/components/flow-connect";

const etapas: FlowConnectItem[] = [
  { key: "lead", label: "Lead capturado", description: "Formulário ou WhatsApp" },
  { key: "triagem", label: "Triagem da IA" },
  { key: "atendimento", label: "Atendimento humano", description: "Handoff com contexto" },
];

<FlowConnect items={etapas} />
<FlowConnect items={etapas} direction="vertical" />
```

| Prop        | Tipo                                       | Default | Comportamento |
| ----------- | ------------------------------------------ | ------- | ------------- |
| `items`     | `{ key, label, description? }[]`           | —       | Um card por item. `description` é opcional. |
| `direction` | `"horizontal" \| "vertical" \| "auto"`     | `"auto"` | `auto`: linha com wrap, virando coluna em ≤640px. `horizontal`: força linha com wrap em qualquer largura. `vertical`: coluna única com setas ↓. |

## Como funciona

- **Cards:** cada item reusa a primitive global `.card` (mesma pausa visual do
  sistema) + `.cardtitle` / `.type-secondary` para o texto. Layout local em
  `flow-connect.module.css`.
- **Setas discretas:** linha 1px em `var(--text-muted)` (token semântico do
  `--text-8`) com cabeça pequena (chevron). Nenhuma cor fora de tokens.
- **Medição real:** um SVG overlay calculado de `getBoundingClientRect` dos
  cards, re-medido por `ResizeObserver`. Card seguinte na mesma linha → seta
  reta `→`; empilhado (coluna) → seta reta `↓`; **quebra de linha (wrap)** →
  conector **curvo** (curva em S, cúbica) saindo da borda direita do card e
  entrando pela esquerda do seguinte.
- **Fallback:** sem medição (SSR, `ResizeObserver` ausente em Safari 12–13,
  erro de medição) os conectores são setas retas inline entre os cards — a
  coluna/≤640px gira o glifo para baixo via CSS.
- **Responsivo:** `auto` (default) vira coluna em ≤640px; `direction="vertical"`
  é sempre coluna.
- **Acessibilidade:** container com `role="list"`, um `role="listitem"` por
  item; todos os conectores são `aria-hidden` (decoração, fora da árvore de
  leitura). Sem `<ol>`, sem números, sem semântica de stepper.

## Quando usar

- Só quando **existe relação lógica de sequência** entre os blocos: pipeline de
  atendimento, etapas de um processo, cadeia de ocorrências. A seta afirma
  "depois deste vem aquele".
- Fluxos curtos (2–6 blocos) em superfícies B2B sóbrias: onboarding explicativo,
  resumo de pipeline, documentação de processo.

## Quando NÃO usar

- **Nunca como wizard/stepper obrigatório** — não há estado de etapa, progresso
  nem bloqueio; para fluxo interativo de etapas use os primitives existentes.
- Não use para listas sem ordem (tags, categorias): é relação de fluxo ou nada.
- Não empilhe numeração manual, badges de passo ou setas grandes: o pattern é
  discreto por definição.
- Não use `direction="horizontal"` em telas mobile: só `auto`/`vertical`
  respeitam o colapso para coluna.

## Testes

`tests/flow-connect.test.tsx` (jsdom). jsdom não mede layout — os testes
mockam `getBoundingClientRect`/`ResizeObserver` e asserem **estrutura**
(papéis ARIA, nº de conectores = itens − 1, forma do path: `L` reto vs `C`
curvo), nunca pixels.
