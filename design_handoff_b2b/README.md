# Handoff: CRM de Atendimento com IA (Nexo)

## Visão geral
Protótipo de um CRM B2B para times comerciais que atendem por WhatsApp, com um copiloto de IA sugerindo respostas, qualificação de leads e reagendamento de reuniões. Três telas: **Conversas** (inbox + chat + painel do lead), **Agenda** (calendário semanal/diário da equipe) e **Pipeline** (kanban de vendas).

## Sobre os arquivos de design
O arquivo incluído (`CRM Atendimento IA.dc.html`) é uma **referência visual em HTML** — um mockup de alta fidelidade, não código para copiar direto. A tarefa é **recriar este design no ambiente do seu projeto atual** (seu framework, componentes e stack existentes), usando este documento e o HTML como referência de layout, espaçamento, cor, tipografia e comportamento.

## Fidelidade
**Alta fidelidade (hifi).** Cores, tipografia, espaçamento e estados (hover, seleção, vazio) estão todos definidos e devem ser reproduzidos com precisão. Os textos e nomes são fictícios/placeholder — substitua pelo conteúdo real do seu produto.

---

## Estrutura geral (shell)

Layout raiz: `display:flex`, altura total da viewport, fundo `--bg`.

### Sidebar (navegação global)
- Largura fixa **212px**, fundo `--surface-2`, borda direita 1px `--border`, padding `14px 12px 12px`.
- **Topo**: logo (quadrado 24×24px, `border-radius:7px`, fundo `--primary`, letra branca) + nome do produto (13.5px, weight 700) + chevron de colapso (ação não implementada no protótipo, é só visual).
- **Navegação primária** (3 itens, ícone 15×15 + label + contador à direita em IBM Plex Mono 10.5px): Conversas, Agenda, Pipeline. Item ativo: fundo `--hover`, texto `--text`, weight 600. Padding do item: `7px 9px`, `border-radius:7px`.
- **Divisor** (linha 1px `--border`, margin `14px 6px`).
- **Seção "Filas"**: label uppercase 10px/600/letter-spacing 0.6px em `--text-8`, depois lista de filas (dot colorido 6px + label + contador). Ex.: "Sem resposta" (dot laranja `#B54708`), "Atribuídas a mim" (dot primary), "Copiloto ativo" (dot cinza `#94A3B8`).
- **Rodapé** (empurrado para baixo via `margin-top:auto`): item "Configurações", toggle de tema claro/escuro (ícone sol/lua + label + switch 30×16px), depois bloco de usuário (avatar circular 24px com iniciais + nome 12px/600 + cargo/status 10.5px em `--text-7`, separado por borda superior).

### Header de cada tela
Todas as 3 telas usam um cabeçalho de **48px de altura**, fundo `--surface-2`, borda inferior 1px `--border`, padding horizontal 16px: título da tela (13.5px/700) à esquerda, ações/filtros à direita (botões outline 28px de altura + 1 botão de ação primária cor `--primary`).

---

## Tela 1 — Conversas

**Propósito**: inbox de atendimento (WhatsApp), com o histórico da conversa ao centro e o contexto do lead + IA à direita.

**Layout**: 3 colunas dentro da área de conteúdo (abaixo do header):
1. Lista de conversas — **322px fixos**, borda direita 1px `--border`, fundo `--surface`.
2. Thread de mensagens — flexível (`flex:1 1 520px`, `min-width:480px`), fundo `--bg`.
3. Painel do lead — **328px fixos**, borda esquerda 1px `--border`, fundo `--surface`, scroll vertical.

### Coluna 1 — Lista de conversas
- Topo: campo de busca (30px altura, ícone lupa, placeholder "Buscar por nome, telefone ou tag") + 4 abas de filtro (Todas / Não lidas / Minhas / IA) — aba ativa com fundo `--hover` e weight 600.
- Cada linha de conversa (padding 12px, ou 9px no modo "compacto" — ver Tweaks): avatar circular 30px com iniciais + nome (12.5px/600) + hora (10.5px mono) + empresa (11px, `--text-6`) + preview da última mensagem (11.5px, 2 linhas com `line-clamp`) + linha de tags/SLA (badge de etapa + indicador de SLA em atraso, dot + tempo em laranja `#B54708`, quando aplicável) + badge de não lidas (círculo 16px, fundo `--primary`, número branco).
- Linha selecionada: fundo `--primary-tint-bg` + barra vertical de 2px na borda esquerda cor `--primary`.
- Hover: fundo `--hover`.

### Coluna 2 — Thread
- **Cabeçalho da conversa** (min 52px): avatar 28px + nome do contato (13px/600) + canal (dot verde WhatsApp `#25D366` + label) + telefone (mono) + à direita: botões de ação (Transferir, Agendar, Snooze — outline) + botão "Resolver" (preenchido, cor primária).
- **Mensagens**: bolhas alinhadas à esquerda (contato, fundo `--surface`, borda `--border`) ou à direita (equipe/IA). Distinção de autor por cor de bolha:
  - Contato: fundo branco/surface.
  - Resposta da IA (copiloto): fundo `--primary-tint-bg`, com badge "IA" (pill 9.5px/700, borda `--primary-tint-border`).
  - Nota interna: fundo bege `#FDFBF5`, borda `#EFE6D4`, badge "NOTA INTERNA" (marrom `#8A6D1F`) — visível só para a equipe, visualmente distinta das mensagens enviadas ao cliente.
  - Resposta humana da equipe: fundo `--primary` sólido, texto branco.
  - Marcador de sistema centralizado (ex.: "Conversa iniciada via WhatsApp…"), texto pequeno cinza, sem bolha.
  - Bolha: `border-radius:10px`, padding `9px 12px`, fonte 12.5px/line-height 1.55. Metadado acima da bolha: autor (10.5px/600) + badge opcional + hora (mono).
- **Painel do copiloto** (condicional, controlado pela tweak `showAiCopilot`): cartão acima do composer, borda arredondada só no topo, com badge "COPILOTO", sinais da IA (Intenção / Sentimento / Plano) alinhados à direita, texto da sugestão, e 3 ações: "Inserir resposta" (primária), "Reescrever" (outline), "Descartar" (texto).
- **Composer**: abas "Responder" / "Nota interna" (mesmo padrão visual das abas da coluna 1), textarea placeholder, respostas rápidas (chips outline: "Enviar proposta", "Confirmar horário", "Pedir CNPJ"), atalho `⌘↵` e botão "Enviar" (desabilitado por padrão neste protótipo — fundo `--disabled-bg`).

### Coluna 3 — Painel do lead
Blocos separados por borda inferior 1px `--border-2`, padding `14–16px`:
1. **Identidade**: avatar 38px + nome (13.5px/700) + cargo/empresa. Botões "Ver lead" / "Agendar" (outline, 28px).
2. **Qualificação**: score numérico (mono, "82/100"), barra de progresso 4px (`--primary-accent`), checklist de critérios (Orçamento, Decisor, Necessidade, Prazo) com marcador ✓ (verde/primary) ou ~ (parcial, âmbar).
3. **Próxima ação**: cartão com título da tarefa, prazo (dot + data em laranja se urgente) e responsável.
4. **Detalhes**: pares chave/valor (Telefone, E-mail, Origem, Etapa, Responsável, Criado em) — label 92px fixos à esquerda, valor truncado à direita. Tags do lead como chips + botão "+ tag" (borda tracejada).
5. **Resumo da conversa (IA)**: badge "IA", lista de bullets (barra vertical 3px + texto) resumindo o contexto — gerado pela IA a partir da thread.

---

## Tela 2 — Agenda

**Propósito**: calendário da equipe comercial, com visão semanal (colunas = dias) ou diária (colunas = pessoas), painel de detalhe do evento selecionado, capacidade da equipe e bloqueios recorrentes.

**Layout**: header (48px) → barra de sub-navegação (44px: navegação de período, toggle "Hoje", intervalo de datas, legenda de tipos de evento) → corpo com grid de calendário (flex 1) + painel lateral direito (296px fixo).

### Grid de calendário
- Coluna de horários à esquerda (56px, fundo `--surface-2`), das 08:00 às 18:00, linhas de 60px por hora.
- Colunas de dia/pessoa (largura mínima 132px, flexível): cabeçalho da coluna (74px com capacidade visível, ou 44px sem — tweak `showCapacity`) mostrando dia da semana + número do dia (mono) e, quando habilitado, barra de mini-slots indicando % de ocupação. Coluna do dia atual tem fundo levemente destacado (`--today-head-bg` / `--today-body-bg`) e cor primária no texto.
- Eventos são blocos absolutamente posicionados dentro da coluna, `border-radius:7px`, cor por tipo:
  - **Reunião** (meet): `--primary-tint-bg` / borda `--primary-tint-border`.
  - **Demo**: azul acinzentado `#EEF1F7` / borda `#D2DAEA`.
  - **Follow-up**: bege `#FAF6EE` / borda `#E9DEC8`.
  - **Bloqueio** (ex.: almoço, planejamento): `--surface-3`, com padrão de listras diagonais 45° sutis (`repeating-linear-gradient`) para indicar indisponibilidade.
  - Cada bloco mostra título (11px/600, truncado), horário (10px mono) e, se houver, o nome do lead.
- Linha de "agora" (now indicator): linha 1px laranja `#B54708` com dot na ponta, posicionada pela hora atual — só na coluna do dia de hoje.

### Painel lateral (evento selecionado)
1. **Reunião selecionada**: título (14px/700), data+hora (mono), campos (Lead, Responsável, Tipo, Canal, Status), botões "Reagendar" (primário) / "Cancelar" (outline).
2. **Horários sugeridos** (condicional — aparece ao clicar "Reagendar"): badge "IA", lista de 3 sugestões de horário com nota contextual ("Livre para Rafael e para o lead") e rótulo de encaixe (Ideal / Bom / Ok, cor decrescente de ênfase).
3. **Capacidade da equipe · hoje**: por pessoa — avatar + nome + carga (ex. "4/5", mono) + barra de progresso colorida por nível de ocupação (verde saudável → laranja alto → vermelho no limite).
4. **Bloqueios recorrentes**: lista simples (barra vertical tracejada + label + horário recorrente).

---

## Tela 3 — Pipeline

**Propósito**: kanban de vendas por etapa, com valor, score de qualificação e próxima ação por card.

**Layout**: header (48px, com toggle Kanban/Lista — só Kanban implementado) → barra de filtros (44px: chips de filtro combináveis por Responsável/Origem/Qualificação/Valor/Última interação + link "Limpar" + estatísticas agregadas à direita: Total, Leads, Conversão) → área de colunas com scroll horizontal.

### Colunas (etapas)
6 etapas: Novo lead → Contato feito → Qualificado → Reunião agendada → Proposta enviada → Ganho. Cada coluna:
- **272px de largura fixa**, `border-radius:10px`, borda `--border`.
- Cabeçalho: dot de cor da etapa + nome + contador (mono) + menu "···"; segunda linha com valor total da etapa (mono) e tempo médio na etapa.
- Corpo com scroll vertical, cards + botão tracejado "+ Adicionar lead" no final.

### Card de lead
- Nome do lead (12.5px/600) + empresa (11px) + avatar do responsável (22px, iniciais).
- Valor do negócio (mono, 12px) + badge de score de qualificação (A/B/C — cor primária para A, neutra para B/C).
- Mini-cartão de próxima ação: dot de status + descrição truncada + prazo (mono, cor vermelha se atrasado, laranja se urgente, neutra se futuro).
- Tags (chips neutros) + tempo na etapa atual (ícone de relógio + duração, canto inferior direito).

---

## Tokens de design

### Tipografia
- **Manrope** (400/500/600/700) — toda a UI (texto, labels, títulos).
- **IBM Plex Mono** (400/500) — valores numéricos, dinheiro, timestamps, telefones, contadores, horários. Usada deliberadamente para diferenciar "dado" de "texto".
- Base: `font-size:13px`, `line-height:1.45`, `-webkit-font-smoothing:antialiased`.
- Escala usada no produto: 10px (labels uppercase), 10.5–11px (metadados), 11.5–12.5px (corpo/UI), 13–14px (títulos de tela/seção), 700 weight para títulos, 600 para ênfase, 500 para texto padrão.

### Cores — tema claro
```
--bg:#F7F7F5           --surface:#FFFFFF        --surface-2:#FBFBF9      --surface-3:#F4F4EE
--hover:#F0F0EA         --border:#E6E6E0         --border-2:#EFEFE9       --border-3:#E0E0D9
--border-4:#F1F1EB      --border-hover:#C9C9C0   --disabled-bg:#E9E9E3
--divider-dash:#DEDED6  --divider-dash-hover:#B8B8AE
--text:#1A1A18  --text-2:#2A2A26  --text-3:#3A3A36  --text-4:#57574F  --text-5:#6B6B64
--text-6:#8A8A82 --text-7:#9A9A92 --text-8:#A3A39A --text-9:#B0B0A8
--today-head-bg:#F7F8F6  --today-body-bg:#FDFDFC
--primary:#0E7490       --primary-fg:#FFFFFF     --primary-hover:#0B5C73   --primary-text:#0E7490
--primary-accent:#22D3EE --primary-tint-bg:#E3F8FB --primary-tint-border:#B9EAF2
```
Cores de apoio usadas pontualmente (fora do sistema de tokens, para status/categorias): laranja de urgência `#B54708`, vermelho de atraso `#B02A16`/`#B02A16`, azul de "demo" `#3B5BA5`/`#EEF1F7`, âmbar de "follow-up"/nota interna `#8A6D1F`/`#FAF6EE`, roxo de indicação `#6B4C8A`.

### Cores — tema escuro
```
--bg:#0E1315  --surface:#171B1D  --surface-2:#14181A  --surface-3:#20262A  --hover:#232A2D
--border:#2A3134  --border-2:#252B2E  --border-3:#333B3E  --border-4:#262D30
--text:#F2F3F1  --text-2:#E2E4E1  --text-3:#C7CAC6  --text-4:#A7ABA6  --text-5:#8E938E
--text-6:#7C8280 --text-7:#6C7274 --text-8:#5C6265 --text-9:#4C5255
--primary:#0E7490  --primary-hover:#159AB4  --primary-text:#67E8F9
--primary-tint-bg:#0B2E35  --primary-tint-border:#1C5560
```
Troca de tema é feita sobrescrevendo as CSS custom properties no `:root` (não são duas folhas de estilo separadas) — reproduza isso como um objeto de tokens por tema no seu sistema de design.

### Espaçamento e formas
- Border-radius: 4–6px em chips/badges pequenos, 6–7px em botões e itens de navegação, 8–10px em cards e cartões, 50% em avatares.
- Bordas: 1px sólidas em quase tudo; bordas tracejadas (`dashed`) só em elementos de ação "adicionar" (+ tag, + lead).
- Divisores entre seções usam `--border-2` (mais sutil) ou `--border` (mais definido) — `--border` para limites estruturais de coluna/painel, `--border-2` para separação interna de blocos.
- Sombras: nenhuma sombra pesada no protótipo — hierarquia é feita por cor de fundo e borda, não por elevação.

## Interações e comportamento
- **Navegação principal**: clique nos itens da sidebar troca a tela ativa (`Conversas` / `Agenda` / `Pipeline`); não há transição de página, é troca de conteúdo no mesmo shell.
- **Seleção de conversa**: clique numa linha da lista troca a thread e o painel do lead exibidos (nesta versão do protótipo o conteúdo da thread é fixo — represente com dados reais/estado por conversa na implementação final).
- **Abas** (Todas/Não lidas/Minhas/IA na lista; Responder/Nota interna no composer; Dia/Semana na agenda): toggle simples de estado local, sem chamadas de rede no protótipo.
- **Toggle de tema**: switch na sidebar alterna claro/escuro globalmente, sobrescrevendo os CSS custom properties.
- **Reagendar** (Agenda): clique em "Reagendar" no painel do evento selecionado revela um bloco de "Horários sugeridos pela IA" — é um `sc-if` local (mostra/esconde), sem lógica de agendamento real.
- **Cards do Pipeline**: hover realça a borda; clique não tem ação implementada no protótipo (era esperado abrir um detalhe do lead).
- **Estados de hover**: presentes em quase todo elemento clicável — mudança sutil de fundo (`--hover` ou `--surface-2`) e/ou cor de borda (`--border-hover`), sem sombra nem escala.
- **Sem drag-and-drop real** no kanban — é só a estrutura visual das colunas.

## Gerenciamento de estado (do protótipo)
Estado local único (não há backend): `screen` (tela ativa), `conv` (conversa selecionada), `convTab`, `composerTab`, `agendaView` (Dia/Semana), `sel` (evento selecionado na agenda), `rescheduling` (bool, mostra sugestões de IA), `pipeView`, `activeFilter`, `theme` (light/dark).

Três flags booleanas expostas como tweaks/props do componente (devem virar feature flags ou preferências de usuário reais na implementação):
- `showAiCopilot` — exibe/esconde o painel de sugestão do copiloto no chat.
- `compactRows` — densidade da lista de conversas (padding 9px vs 12px).
- `showCapacity` — exibe/esconde a barra de capacidade nos cabeçalhos de coluna da agenda.

## Assets
Nenhuma imagem externa. Todos os ícones são SVGs inline desenhados à mão (lupa, seta, calendário, engrenagem, sol/lua, relógio, chat) — no seu projeto, substitua por um icon set consistente (ex. Lucide/Feather) com a mesma métrica visual (~15px, stroke 1.3px). Avatares são iniciais sobre fundo colorido (sem fotos).

## Arquivos incluídos neste pacote
- `CRM Atendimento IA.dc.html` — protótipo completo (referência de layout/estilo/estado), abre direto no navegador.
