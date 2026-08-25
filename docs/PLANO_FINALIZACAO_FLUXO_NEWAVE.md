# Fluxo agentivo Newave IA

## Estado final

A Newave opera em um workspace próprio (`newave-ia`), com sessão de WhatsApp, instrução e conjunto de ferramentas isolados do Meta Cell IA. Não existe gatilho por palavra-chave nem interceptação global de mensagens: toda conversa da sessão Newave segue o prompt do agente Newave, enquanto o Meta Cell continua usando sua instrução e suas tools originais.

O formulário determinístico das migrations 0038–0040 é histórico. A migration posterior desativa todos os fluxos legados; o runtime, a outbox e os controles desse formulário foram removidos.

## Conversa e avaliação

O agente pergunta naturalmente, uma questão por vez, reconhece o que foi dito e aceita respostas livres ou fora de ordem. Busca compreender tempo de mercado, faturamento, nicho, causa de perda de vendas, possibilidade de investimento quando pertinente e Instagram. Não usa palavras-chave, faixas fixas ou soma de pontos.

A avaliação é registrada por `qualificar_lead` com 1–5 estrelas, respostas estruturadas, resumo, justificativa interna e data. A nota considera o contexto completo; faturamento é relevante, mas não decide sozinho.

- 1–5★: a avaliação é registrada como contexto e os aliases de reunião ficam disponíveis para todos.
- informação insuficiente ou caso duvidoso: pode ser tratado como 2★, sem pausar ou descartar o lead.

A nota e os critérios são internos. O contato nunca é chamado de desqualificado. A equipe pode aproveitar casos de baixa prontidão com cursos e outras ofertas.

## Segurança e atribuição

O webhook mantém apenas campos CTWA/referral normalizados e limitados. O payload bruto da Meta não é persistido. A atribuição segura fica na conversa até o cadastro e é copiada para o lead.

As tools são filtradas por `agent_configs.enabled_tools` e validadas novamente no executor. O Newave recebe cadastro, qualificação e reunião. A transferência não é uma decisão do modelo: pedidos explícitos de atendimento humano são detectados deterministicamente antes da geração, inclusive para versões antigas que ainda tenham `transferir_atendente` salvo na configuração.

O handoff autorizado sempre pausa a IA e deixa a conversa no painel. Se houver telefone interno válido, uma notificação externa é enfileirada; sem telefone, o handoff continua funcionando sem notificação. Dúvida, resposta incompleta, objeção, frustração ou situação fora do fluxo não autorizam handoff.

## Provisionamento

Execute de forma idempotente:

```bash
npm run provision:newave -w @atendon/backend
```

O comando garante:

- tenant Newave IA em `America/Sao_Paulo`;
- `arthurmuller07@gmail.com` no papel OWNER;
- agente com modelo, temperatura, ferramentas e prompt ativo definidos no painel; `instrução-newave-ia.md` é o template versionado e suas mudanças entram primeiro como versão candidata;
- sessão própria de WhatsApp;
- agenda “Reuniões comerciais”, segunda a sexta, 09h–18h, slots de 60 minutos e capacidade 1.

## Checklist operacional

- Aplicar migrations e executar o provisionamento.
- Configurar a chave OpenRouter e conectar a sessão WhatsApp do workspace Newave.
- Conferir no painel o expediente, duração e capacidade da agenda, que são a fonte de verdade operacional.
- Follow-ups usam atrasos cumulativos configuráveis desde a resposta original; a cadência inicial é 2h, 24h e 72h.
- Reexecutar o provisionamento não sobrescreve prompt/versão ativa, modelo, expediente, duração, capacidade nem a cadência já administrada no painel.
- Fazer smoke test com respostas livres, ambíguas, recusas e mudanças de assunto.
- Confirmar que 1–2★ também consultam horários e concluem a reunião sem entrar na fila humana pela nota.
- Confirmar que 3★ consulta slots e conclui a reunião.
- Conferir estrelas, respostas, resumo, justificativa e origem Facebook no lead.
- Repetir cadastro, qualificação e chamadas de reunião para validar idempotência.
- Abrir uma conversa do Meta Cell e confirmar prompt e tools inalterados.
