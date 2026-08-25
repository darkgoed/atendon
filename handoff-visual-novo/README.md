# Handoff: Visual Redesign da AtendON (aplicar em todo o sistema)

## Overview
Redesign visual do AtendON (plataforma de atendimento/CRM via WhatsApp com IA). Duas telas foram redesenhadas como referência: **Conversas** (inbox de chat) e **Agenda** (calendário de agendamentos). O objetivo deste handoff é levar esse novo visual — cores, tipografia, componentes, espaçamento — para **todas as demais páginas do sistema**, não apenas estas duas.

## About the Design Files
Os arquivos HTML deste pacote são **referências de design**, protótipos que demonstram a aparência e o comportamento pretendidos — não é código de produção para copiar diretamente. A tarefa é **recriar esse visual no ambiente/stack já existente do sistema AtendON** (o framework, componentes e padrões que o codebase real já usa), aplicando o mesmo sistema visual (cores, fontes, espaçamento, componentes) a todas as telas do produto, mantendo a estrutura/funcionalidade que cada tela já tem.

## Fidelity
**Alta fidelidade (hifi)**: os dois protótipos têm cores finais, tipografia definida, espaçamento e estados de interação (hover implícito, seleção, abertura de painéis) prontos para reprodução pixel-precisa. Use os valores exatos abaixo — não aproxime.

## Design Tokens

### Cores — tema escuro (padrão)
- Fundo de página: `#0D0C0E` (com textura sutil: `radial-gradient(circle at 1px 1px, rgba(255,255,255,0.03) 1px, transparent 0)`, `background-size: 24px 24px`)
- Painel/sidebar: `#151317`
- Painel secundário (ex. coluna de chat, grade do calendário): `#121014` / `#1D1A1F`
- Borda: `#2A262B` · Borda forte: `#38333A`
- Texto primário: `#F3F1EE` · Secundário: `#A39D9B` · Muted: `#6B6568` · Faint: `#59535A`
- Acento (cor de marca): `#22D3EE` (ciano) — texto sobre acento: `#062A30`
- Acento soft bg: `rgba(34,211,238,0.12)` · Acento border: `rgba(34,211,238,0.25)`
- Sucesso/ativo: `#6BCB7A` · Alerta/pausado: `#F5A623` · Erro/conflito: `#E5484D` · Info: `#5B9BD9`
- Cores de "closer"/pessoa (agenda): Julia `#9D8CFF`, Beto `#7C93B0`

### Cores — tema claro (toggle disponível, ver botão de sol/lua no rodapé da sidebar)
- Fundo de página: `#F3F1EE` · Painel: `#FFFFFF` · Painel secundário: `#FAF9F7`
- Borda: `#E4E0DC` · Borda forte: `#D3CDC7`
- Texto primário: `#18151A` · Secundário: `#5B5650` · Muted: `#8B857E` · Faint: `#A39D9B`
- Acento texto: `#0B93A6` · Acento soft bg: `rgba(14,165,182,0.1)` · Acento border: `rgba(14,165,182,0.3)`

O sistema deve suportar os dois temas com toggle (ver `toggleTheme` nos dois protótipos).

### Tipografia
- Fonte de interface: **Space Grotesk** (pesos 500/600/700) — títulos, labels, corpo de texto.
- Fonte monoespaçada: **IBM Plex Mono** (pesos 400/500/600) — timestamps, IDs (`CV—01`, `AG—01`), badges de versão (`v1.1.4`), atalhos de teclado (`Ctrl K`), valores de hora na grade da agenda.
- Google Fonts: `family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600`.
- Tamanhos usados: 24px (título de página), 18px (título de seção), 15px (nome de contato), 13–13.5px (corpo/labels), 12–12.5px (secundário), 10.5–11px (labels de seção em maiúsculas, letter-spacing 0.6–0.8px), 10px (timestamps mono).

### Espaçamento & formas
- Border-radius padrão: 5–6px em cards, inputs, botões; 50% em avatares/dots.
- Sidebar fixa: 236px de largura.
- Borda de 1px em quase todos os contêineres (nunca sombra pesada); sombras só em popovers/painéis flutuantes (`box-shadow:0 6px 18px rgba(0,0,0,0.25)` ou `-8px 0 24px rgba(0,0,0,0.3)` para painel lateral).
- Ícones: outline SVG (stroke, não fill), stroke-width 1.6–2, 13–18px de tamanho conforme contexto.

## Screens / Views

### 1. Sidebar de navegação (compartilhada por todo o sistema)
Presente em ambas as telas, deve ser reutilizada em todas as páginas:
- Largura 236px, fundo `#151317`, borda direita `#2A262B`, padding 18px 14px.
- Topo: logo (círculo ciano + ícone) + wordmark "AtendON", 15px/700.
- Campo de busca com atalho "Ctrl K" à direita.
- Grupos de navegação com labels de seção em maiúsculas (10.5px/700, letter-spacing 0.8px, cor `#59535A`): **ATENDIMENTO** (Visão geral, Alertas, Conversas, Leads, Pipeline, Agenda), **IA** (Agente, Figurinhas, Melhoria da IA, Humanização), **CONFIGURAÇÕES** (Conexão, Catálogo, Membros, Funções, Chaves de API, Auditoria).
- Item ativo: fundo `rgba(34,211,238,0.12)`, texto `#22D3EE`, font-weight 600; itens inativos em `#A39D9B`.
- Badge de contagem (ex. "1" em Conversas): fundo `#22D3EE`, texto `#062A30`, 10.5px/700, radius 4px.
- Rodapé: avatar (círculo com iniciais, fundo `#2A262E`), nome + role ("ROOT"), toggle de tema (ícone sol/lua), ícone de logout — separados por borda superior.

### 2. Header de workspace (compartilhado)
Barra fina no topo do conteúdo (abaixo da sidebar, acima do conteúdo da página): fundo `#100E11`, borda inferior `#2A262B`, padding 11px 22px. Mostra: dot de status verde + nome do workspace ("Newave IA") + slug mono + badge "ATIVO" (fundo `rgba(107,203,122,0.14)`, texto `#6BCB7A`); à direita, versão mono (`v1.1.4`) e link "Novidades" com ícone de check em círculo, cor de acento.

### 3. Conversas (inbox)
- **Layout**: sidebar (236px) + coluna de lista de conversas (308px) + painel de chat (flex:1).
- **Coluna de lista**: título "Conversas" + badge mono "CV—01" (borda/fundo de acento); subtítulo status da conexão; campo de busca; tabs segmentadas (Abertas / IA / Resolvidas) — tab ativa com fundo soft de acento e texto de acento; lista de conversas com avatar circular (iniciais), nome, timestamp mono, preview de mensagem truncado, e indicador de status (dot colorido + label: "IA ativa" verde, "IA pausada" laranja, "Resolvida" cinza). Linha selecionada com fundo soft de acento.
- **Painel de chat**: header com avatar, nome do contato, badge de status (ex. "IA pausada" com dot laranja), telefone + "visto por último"; ações à direita: botão primário "Agendar" (fundo ciano sólido, texto escuro), botão secundário "Resolver" (outline), menu "mais" (ícone de 3 pontos) que abre dropdown (Avaliar com IA / Trocar assinatura / Reativar IA).
- Banner de aviso quando IA pausada: fundo laranja translúcido, borda laranja, ícone de pause.
- **Bolhas de mensagem**: recebidas alinhadas à esquerda (fundo do painel, borda sutil); enviadas alinhadas à direita (fundo soft de acento, borda de acento); timestamp mono abaixo, com ✓✓ para enviadas. Mensagens de formulário/lead mostram uma grade de pares label/valor (Instagram, Nicho, Tempo de mercado, Faturamento, etc).
- **Composer**: input de texto com ícone de anexo à esquerda, ícone de áudio, botão de enviar circular ciano com ícone de avião de papel; texto de ajuda abaixo (atalhos, limites de arquivo).

### 4. Agenda (calendário semanal)
- **Layout**: sidebar + header de workspace + banner de acesso assistido ("Acesso assistido ROOT em Newave IA...") + área de conteúdo com grade de calendário.
- **Cabeçalho da página**: eyebrow "PAINEL · ATENDIMENTO", título "Agenda" + badge mono "AG—01", subtítulo de instrução. À direita: legenda de closers (dots coloridos + nome), dropdown de filtro por closer, toggle segmentado Dia/Semana (ativo = fundo ciano sólido, texto escuro).
- **Navegação de data**: seta anterior/próxima (botões quadrados com borda), botão "HOJE" (soft de acento), label de intervalo em mono.
- **Grade**: coluna de horas (mono, alinhado à direita) + colunas por dia (cabeçalho com dia da semana abreviado + data; dia atual destacado com fundo soft de acento e borda inferior ciano de 2px). Linhas de meia-hora sutis; dias fechados mostram padrão hachurado "Fechado".
- **Cards de agendamento**: posicionados absolutamente por horário/duração, borda esquerda de 3px na cor do closer, fundo soft na mesma cor; mostram nome do lead, pill de status (Confirmado verde, Reagendado azul, Conflito vermelho, Ocupado cinza) e nome do closer com dot colorido. Slots sem nome mostram apenas o status em itálico centralizado.
- **Painel lateral de detalhe** (ao clicar em um card): overlay escuro + painel deslizante da direita (380px), fundo de painel, mostra nome + horário, pill de status + responsável, linha de ações (ícones: ligar, gravar/vídeo, agendar, confirmar/check, cancelar/X) e campo de observação (textarea).

## Interactions & Behavior
- **Toggle de tema** (sol/lua no rodapé da sidebar): alterna todas as cores entre os tokens dark/light listados acima — deve ser global no app, não por tela.
- **Tabs/segmented controls**: clique troca o filtro ativo, estado visual = fundo soft de acento + texto de acento (Conversas) ou fundo ciano sólido + texto escuro (Agenda Dia/Semana).
- **Dropdowns** (menu "mais" em Conversas, filtro de closer em Agenda): abrem um popover posicionado abaixo/à direita do gatilho, fecham ao selecionar uma opção ou clicar fora.
- **Seleção de linha/card**: clique em uma conversa ou agendamento marca como selecionado (fundo soft de acento) e, na Agenda, abre o painel lateral de detalhe.
- **Painel lateral (Agenda)**: abre com overlay de fundo escuro semi-transparente que fecha o painel ao ser clicado; textarea de observação persiste por agendamento.
- **Navegação de datas**: setas avançam/retrocedem semana (ou dia, no modo Dia); botão "Hoje" retorna à data atual.
- **Busca**: filtro client-side por nome/telefone, atualiza lista em tempo real.
- Nenhuma animação elaborada — é uma interface funcional e direta; usar transições rápidas e sutis (ex. 150–200ms) em hover/estado se o codebase já tiver esse padrão.

## State Management
- Tema atual (dark/light) — deve ser global (idealmente persistido, ex. localStorage/preferência de usuário).
- Tab/filtro ativo por tela (Conversas: abertas/ia/resolvidas; Agenda: todos/julia/beto; Agenda: dia/semana).
- Conversa selecionada / agendamento selecionado (abre painel de detalhe).
- Estado de abertura de dropdowns/menus (fechar ao clicar fora).
- Texto de busca, texto de mensagem em composição, texto de observação por agendamento.
- Offset de semana / índice de dia para navegação de calendário.

## Assets
Nenhuma imagem externa — todos os ícones são SVG inline (outline style, stroke currentColor). Fontes via Google Fonts (Space Grotesk, IBM Plex Mono). Recriar os SVGs conforme a biblioteca de ícones já usada no codebase (ex. Lucide/Feather têm equivalentes visuais muito próximos aos usados aqui), mantendo o estilo outline fino.

## Files
- `AtendON Conversas.dc.html` — protótipo da tela de Conversas (inbox de chat).
- `AtendON Agenda.dc.html` — protótipo da tela de Agenda (calendário semanal).

Aplicar este sistema visual (cores, tipografia, sidebar, header de workspace, componentes de card/pill/dropdown, tokens de espaçamento/radius) às demais telas do sistema (Visão geral, Alertas, Leads, Pipeline, Agente, Figurinhas, Melhoria da IA, Humanização, Conexão, Catálogo, Membros, Funções, Chaves de API, Auditoria), reaproveitando a mesma sidebar e header em todas.
