# Qualificação de contatos vindos do Facebook

O Facebook é a origem do lead; a qualificação acontece no WhatsApp pela conversa do agente Newave. A antiga árvore `P1…P6 / E1…E3` está aposentada e não deve ser reativada.

## Entrada

Quando a Meta envia `referralMessage` ou `externalAdReply`, o webhook extrai somente os campos permitidos: tipo, id e URL da origem, título, texto, tipo de mídia, thumbnail e `ctwa_clid`. Esses dados são normalizados, limitados e associados à conversa/lead. O payload bruto não é armazenado.

Quando o provedor enviar respostas preenchidas separadamente, elas são preservadas como um mapa genérico de rótulo/valor. Quando vierem no texto, o backend reconhece linhas `campo ou pergunta: resposta`: uma linha já basta quando há atribuição de anúncio ou indicação de formulário; sem esse contexto, são exigidas duas para não confundir uma frase comum com formulário. Não existe catálogo fixo: cada anúncio pode usar perguntas diferentes. O agente recebe uma nota explícita de que todos esses campos já foram respondidos e não pode perguntar, confirmar nem reformulá-los.

## Condução

O agente não apresenta um formulário. Ele conversa como representante da equipe Newave e, uma pergunta por vez, procura compreender:

- tempo de mercado;
- faturamento aproximado;
- nicho;
- motivo de perda de vendas;
- possibilidade de investimento, quando aplicável;
- Instagram.

Respostas podem ser livres, indiretas, ambíguas, incompletas ou fora de ordem. Opções servem apenas para esclarecer uma dúvida, nunca para forçar respostas fechadas. Recusas são respeitadas e a avaliação continua com o contexto disponível; nenhuma dessas situações aciona atendimento humano por si só.

O handoff conversacional acontece somente diante de pedido explícito do contato para falar com uma pessoa. Dúvidas, objeções, frustração, mudanças de assunto, perguntas difíceis e informações inesperadas devem ser esclarecidas dentro da conversa. Falhas técnicas esgotadas continuam sendo tratadas separadamente pelo runtime.

Depois de registrar qualquer nota de 1★ a 5★, o agente consulta a agenda começando pela data mais próxima e oferece horários concretos retornados. Perguntas abertas como “quais horários são melhores?” e frases como “tenho disponibilidade de reunião?” são bloqueadas e reescritas antes do envio.

## Decisão interna

`qualificar_lead` registra de 1 a 5 estrelas, respostas estruturadas, resumo e justificativa. Não há fórmula por faturamento nem classificação por palavras-chave.

- 5★: perfil e prontidão muito fortes.
- 4★: encaixe sólido.
- 3★: oportunidade viável.
- 2★: baixa prontidão, informação insuficiente ou dúvidas relevantes.
- 1★: incompatibilidade clara com a oferta principal.

Toda nota segue para consulta da agenda e tentativa de reunião. A qualificação continua registrada como contexto interno, mas não pausa, descarta nem bloqueia `agendar_reuniao`.

Se o contato não responder, o fluxo faz até 3 retomadas curtas, variadas e descontraídas, sempre preservando o assunto pendente e o foco no agendamento.

## Operação no painel

A lista de leads permite filtrar por estrelas e pela fila humana. O detalhe exibe respostas, resumo, justificativa interna, data da avaliação e atribuição Facebook. Não existem controles para pausar, retomar ou reiniciar o formulário legado.
