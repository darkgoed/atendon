# Fluxograma do fluxo atual da IA

> Mapeamento do código em 15/07/2026. Este documento descreve o que o backend executa hoje, não apenas o fluxo idealizado nos arquivos de instrução.

## Visão geral

O AtendON tem um único motor técnico de atendimento. Cada workspace fornece ao motor seu próprio prompt, modelo, provedor, chave OpenRouter, configuração de humanização e lista de ferramentas habilitadas. Por isso, Meta Cell e Newave percorrem a mesma infraestrutura, mas executam fluxos comerciais diferentes.

```mermaid
flowchart TD
    A[Contato envia mensagem no WhatsApp] --> B[Evolution API envia webhook]
    B --> C{Segredo do webhook,<br/>evento e instância são válidos?}
    C -- Não --> C1[Retorna erro HTTP<br/>e não processa]
    C -- Sim --> D{Tipo do evento}
    D -- MESSAGES_UPDATE --> D1[Atualiza status<br/>enviado, entregue ou lido]
    D -- QR/CONNECTION --> D2[Atualiza estado da sessão]
    D -- MESSAGES_UPSERT --> E[Normaliza mensagem e atribuição Meta]
    E --> F{É status, grupo,<br/>broadcast ou conteúdo vazio?}
    F -- Sim --> F1[Ignora]
    F -- Não --> G[Enfileira no BullMQ/Redis<br/>com ID idempotente]
    G --> H[Worker chama MessageProcessor]

    H --> I{Mensagem enviada<br/>por humano/fromMe?}
    I -- Sim --> I1[Registra no histórico<br/>e encerra sem chamar IA]
    I -- Não --> J[Grava entrada e carrega contexto]
    J --> J1[Conversa + histórico + prompt + modelo<br/>tools + humanização + fuso + atribuição]

    J1 --> K{Duplicada ou já<br/>em processamento?}
    K -- Sim --> K1[Encerra como duplicate]
    K -- Não --> L{IA global e da<br/>conversa estão ativas?}
    L -- Não --> L1[Marca processada e ignora]
    L -- Sim --> M[Debounce de fragmentos<br/>e lock por conversa]
    M --> N{Conseguiu o lock?}
    N -- Não --> N1[Lança retry; BullMQ tenta novamente]
    N -- Sim --> O[Marca mensagens como lidas<br/>e absorve fragmentos pendentes]

    O --> P{Contato pediu humano?}
    P -- Sim --> P1[Pausa IA + cria handoff<br/>+ notifica atendente]
    P -- Não --> Q{É áudio, imagem<br/>ou documento?}
    Q -- Sim --> Q1[Envia fallback configurado<br/>sem chamar o modelo]
    Q -- Não --> R{Tentativa de<br/>prompt injection?}
    R -- Sim --> R1[Envia resposta fixa de segurança]
    R -- Não --> S{Excedeu rate limit?}
    S -- Sim --> S1[Marca processada e ignora]
    S -- Não --> T[Monta prompt protegido e chama OpenRouter]

    T --> U{Modelo solicitou tools?}
    U -- Sim --> V[Valida e executa tools idempotentes]
    V --> W[Devolve resultado ao modelo]
    W --> T
    U -- Não --> X[Sanitiza texto e remove ecos/repetições]

    X --> Y{Resposta contém HANDOFF<br/>ou tool acionou handoff?}
    Y -- Sim --> P1
    Y -- Não --> Z[Divide resposta em bolhas]
    Z --> AA[Simula composing, pausas<br/>e reação opcional]
    AA --> AB{Chegou nova mensagem<br/>enquanto digitava?}
    AB -- Sim --> AC[Atualiza contexto e regenera<br/>sem repetir bolhas já enviadas]
    AC --> T
    AB -- Não --> AD[Envia bolhas pela Evolution API]
    AD --> AE[Registra resposta e marca<br/>entradas como processadas]
    AE --> AF[Libera lock da conversa]

    P1 --> AG[Contato não recebe aviso<br/>de transferência]
    Q1 --> AF
    R1 --> AF
    S1 --> AF
    AG --> AF
```

## O que a IA recebe em cada chamada

Antes de chamar a OpenRouter, o backend combina:

1. uma política fixa de segurança, continuidade, tom, uso de ferramentas e handoff silencioso;
2. o prompt comercial configurado no workspace;
3. o nome do perfil do WhatsApp, marcado como dado não confiável;
4. data, hora e fuso do workspace;
5. até 100 mensagens recentes, limitadas a 24 mil caracteres;
6. somente as ferramentas habilitadas para aquele agente.

A política fixa é colocada ao redor do prompt do tenant por `protectedSystemPrompt`. Portanto, em caso de conflito, o comportamento protegido do backend é o efetivo. Um exemplo importante: o arquivo antigo da Meta Cell contém exemplos avisando que chamará alguém da equipe, mas o runtime atual exige handoff silencioso e suprime qualquer texto visível ao contato.

## Loop interno da OpenRouter e das ferramentas

```mermaid
flowchart LR
    A[Prompt protegido + histórico] --> B[POST OpenRouter /chat/completions]
    B --> C[Registra tokens e custo<br/>da requisição]
    C --> D{Retornou tool_calls?}
    D -- Não --> E{Texto final foi cortado?}
    E -- Sim --> F[Aumenta orçamento e pede<br/>reescrita curta e completa]
    F --> B
    E -- Não --> G[Retorna texto final]

    D -- Sim --> H{Tool está habilitada<br/>e argumentos são válidos?}
    H -- Não --> I[Produz resultado JSON de erro<br/>sem expor erro ao contato]
    H -- Sim --> J[Reserva chamada no journal<br/>para impedir efeito duplicado]
    J --> K[Executa ação no banco/serviço]
    K --> L[Persiste resultado no journal]
    I --> M[Adiciona resultado como role=tool]
    L --> M
    M --> N{Atingiu 4 rodadas<br/>de ferramentas?}
    N -- Não --> B
    N -- Sim --> O[Desabilita novas tools e força<br/>uma resposta final com os resultados]
    O --> B
```

As ações disponíveis no conjunto completo são:

- cadastro e funil: `registrar_lead`, `atualizar_status_lead`, `qualificar_lead`;
- consultas: `consultar_categorias`, `consultar_parceiros`, `consultar_unidades`, `consultar_agendas`;
- agenda: consultar horários, agendar, reagendar e cancelar visita ou reunião;
- proposta: `enviar_proposta_parceiro`;
- verificação externa: `pesquisar_modelo`, usando uma chamada OpenRouter separada com plugin de busca web;
- atendimento humano: `transferir_atendente`.

Nem todo agente recebe todas elas. A lista vem de `agent_configs.enabled_tools` e é verificada novamente pelo executor antes de qualquer ação.

## Fluxo comercial do workspace Newave

```mermaid
flowchart TD
    A[Início ou continuação da conversa] --> B[Apresenta Arthur apenas<br/>em conversa nova]
    B --> C[Confirma/obtém nome e registra lead cedo]
    C --> D[Conversa naturalmente,<br/>uma pergunta por vez]
    D --> E[Compreende tempo de mercado,<br/>faturamento, nicho, perdas,<br/>aderência e Instagram]
    E --> F{Há contexto suficiente<br/>ou não há mais o que obter?}
    F -- Não --> D
    F -- Sim --> G[qualificar_lead uma única vez<br/>com 1 a 5 estrelas]
    G --> H[Avaliação registrada como contexto interno]
    H --> I[consultar_agendas]
    I --> J[verificar horários de hoje<br/>ou próximo dia útil]
    J --> K[Oferece 2 ou 3 horários concretos]
    K --> L{Contato confirmou<br/>um horário?}
    L -- Não --> K
    L -- Sim --> M[agendar_reuniao]
    M --> N{Tool confirmou sucesso?}
    N -- Sim --> O[Confirma reunião ao contato]
    N -- Não e não recuperável --> P[Handoff silencioso]

    D -- Pedido de humano ou caso sensível --> P
    P --> Q[Pausa IA e coloca conversa<br/>na fila humana do painel]
```

Regras de negócio reforçadas pelo servidor:

- reunião pode ser criada para qualquer lead com qualificação registrada, de 1 a 5 estrelas;
- nota, justificativa, status técnico e nomes de ferramentas nunca são mostrados ao contato;
- avaliações de 1–2 estrelas continuam registradas como contexto e também seguem para oferta de horários;
- cadastro, qualificação e agendamento são protegidos contra repetição pelo journal de tool calls.

## Fluxo comercial do workspace Meta Cell

```mermaid
flowchart TD
    A[Cliente entra pelo WhatsApp/anúncio] --> B[Entende produto de interesse]
    B --> C{Citou modelo específico?}
    C -- Sim --> D[pesquisar_modelo obrigatoriamente]
    D --> E[Não revela resultado técnico<br/>nem promete estoque]
    C -- Não --> F[Continua conversa]
    E --> F
    F --> G[Entende perfil para financiamento]
    G --> H[Explica Newave antes do link]
    H --> I[Consulta parceiro e envia proposta]
    I --> J[Atualiza lead e etapa do funil]
    J --> K{Cliente aprovado quer<br/>ir à loja?}
    K -- Sim --> L[verificar_horarios]
    L --> M[agendar_visita após confirmação]
    K -- Não --> N[Continua acompanhamento]
    G --> O{Precisa de decisão humana,<br/>estoque/preço exato ou reclamação?}
    O -- Sim --> P[transferir_atendente<br/>com handoff silencioso]
```

## Tratamento de concorrência, duplicidade e falhas

- O job da entrada usa tenant, sessão e ID externo como identificador; reentregas iguais não criam outro job efetivo.
- A mensagem também possui chave única no PostgreSQL e uma lease de processamento.
- Apenas um turno de IA por conversa pode passar do lock Redis ao mesmo tempo; o lock é renovado durante respostas longas.
- Fragmentos enviados em sequência são agrupados por debounce.
- Uma mensagem nova durante o `composing` faz a resposta ser regenerada com o contexto atualizado.
- Tool calls possuem journal por mensagem e ordinal, evitando repetir efeitos como cadastro ou agendamento durante retries.
- O worker tenta a entrada até 5 vezes com backoff exponencial. Depois do esgotamento, cria um alerta de sistema.
- Notificações de handoff usam outbox/fila própria e um reconciliador periódico, para não perder a notificação ao atendente.

## Arquivos que implementam o fluxo

| Responsabilidade | Arquivo |
|---|---|
| Receber e validar webhook | `apps/backend/src/app.ts` |
| Converter payload Evolution em mensagem interna | `apps/backend/src/modules/whatsapp/evolution-webhook.ts` |
| Fila de entrada | `apps/backend/src/queue/message-queue.ts` |
| Workers de IA, humano e handoff | `apps/backend/src/worker.ts` |
| Montagem do runtime | `apps/backend/src/runtime.ts` |
| Orquestração principal do turno | `apps/backend/src/modules/messages/process-message.ts` |
| Persistência, contexto, histórico e idempotência | `apps/backend/src/modules/messages/repository.ts` |
| Política protegida e bloqueio de injection | `apps/backend/src/modules/ai-router/prompt-guard.ts` |
| Cliente OpenRouter e loop de tools | `apps/backend/src/modules/ai-router/openrouter.ts` |
| Catálogo de ferramentas | `apps/backend/src/modules/ai-router/tools.ts` |
| Validação e execução das ferramentas | `apps/backend/src/modules/ai-router/tool-executor.ts` |
| Regras de agenda, lead e qualificação | `apps/backend/src/modules/scheduling/service.ts` |
| Humanização, debounce e lock | `apps/backend/src/modules/messages/humanizer.ts` |
| Prompt comercial Meta Cell | `instrução-ia.md` |
| Prompt comercial Newave | `instrução-newave-ia.md` |

## Resumo em uma frase

A IA recebe a conversa já persistida e protegida, decide entre responder ou executar ações controladas, pode iterar com ferramentas até produzir uma resposta final, envia essa resposta de forma humanizada e idempotente e, quando não deve continuar, pausa silenciosamente a conversa para atendimento humano.
