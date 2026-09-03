# Findings — rodada Newave sem follow-up

## Escopo e fonte

- Fonte bruta: `comments.md`, hash baseline: `5a6eb80a96c91542120b377314cd6f97f7fc2ae23cd84671d056c530488e0f58`; não editar.
- Há dois scripts na fonte: agendamento/qualificação (seções 1–12 e preço/material/objeções) e apresentação/fechamento (abertura, diagnóstico, dor, apresentação, demonstração, potencial, investimento, fechamento e objeções).
- A seção 26, entre `## 26. Follow-up, lembretes e ausência` e `## 27. Transferência humana`, tem 2736 bytes e SHA-256 `dcdc4ba7bd13a7c1113c9ac037df0ce33c2459f5060a7c9c5ceca0befa4e7b79`; deve permanecer byte a byte intacta.

## Intenção não-follow-up extraída

1. Arthur faz primeiro contato no WhatsApp como SDR, acolhe o formulário, pede permissão e qualifica antes de agendar.
2. Qualificação: segmento/cidade, ticket médio, vendas/volume mensal, pagamentos/financiamento, perdas por crédito, financeiras/recusas, equipe, decisor e momento.
3. Checklist adaptativo: uma pergunta por mensagem, contexto reutilizado, sem exigir todos os campos.
4. A regra nova substitui o teto antigo de somente duas perguntas; decisor/momento entram quando mudam o próximo passo.
5. Explicar aderência, oportunidade e valor sem descarte ou garantia; projeções usam somente números do lead.
6. Arthur pode explicar, demonstrar orientativamente, tratar objeções e preparar/agendar especialista; não conduz apresentação humana nem formaliza venda.
7. Google Meet de 20–40 minutos; horários reais; exatamente 2 opções quando houver pelo menos 2 e 1 quando única.
8. Preço, material, proposta, contrato, investimento, documentação, treinamento e implantação só com dados/capacidades oficiais; não inventar.
9. Confirmação imediatamente após agendar é parte do agendamento.
10. Diagnóstico, demonstração, projeção, investimento, fechamento por escolha e confirmação de venda precisam de transição operacional e limite SDR.

## Exclusões verificadas

- Lembrete dia anterior e 30 minutos antes.
- Follow-up sem resposta em 24 horas, 3 dias ou final.
- Follow-up pós-reunião ou com prazo.
- Encerramento profissional por cadência.
- Qualquer alteração na seção 26.

## Investigação do sistema

- Fonte: `instrução-newave-ia.md`; runtime lê versão ativa de `agent_config_versions`; `loadNewavePromptTemplate` precisa ser testado.
- Publicação segue versões imutáveis: aposentar ativa, inserir nova, atualizar `active_version_id`.
- 0128 é a publicação anterior; 0129 pertence a outro trabalho; a próxima é 0130.
- Migration deve ser tenant-safe/idempotente, preservar prefixo e anexar somente bloco sem follow-up. Source-file e migration devem ser semanticamente equivalentes.
- Edição concorrente já existente em `fresh-migrations` exige reler versão atual e aplicar patch mínimo, nunca sobrescrever.

## Autorização e cronologia da execução

- A implementação das mudanças de `comments.md` na instrução NEWAVE foi autorizada pelo usuário; follow-ups/lembretes/ausência/cadência continuam excluídos.
- A etapa inicial era documental. Depois, a implementação autorizada foi concluída nos quatro arquivos: `instrução-newave-ia.md`; `apps/backend/src/db/migrations/0130_newave_sales_script_prompt.sql`; `apps/backend/tests/newave-sales-script-prompt.integration.test.ts`; `apps/backend/tests/fresh-migrations.integration.test.ts`.
- Esta etapa final é exclusivamente documental e não altera código, migration, testes, `comments.md`, seção 26, deploy ou commit.

## Riscos e decisões

- Testes devem ser TDD com RED real antes de prompt/migration e GREEN depois, incluindo publicação/leitura real, idempotência, isolamento tenant, prefixo, sufixo sem follow-ups, equivalência semântica, carregamento por `loadNewavePromptTemplate` e hash da seção 26.
- Nenhum bloqueio factual para o registro documental; a implementação autorizada e os testes foram concluídos conforme os resultados registrados, sem deploy ou commit.

## Finding final — precedência de horários

- A regra do bloco comercial é 0/1/2: zero não inventa disponibilidade, uma opção oferece uma, e duas ou mais oferecem exatamente duas. A regra 2–3 da seção 26 permanece preservada e não é sobrescrita pela regra 0/1/2.
- O conflito de precedência foi reproduzido em TDD RED (1 falha/7 passagens), resolvido com a distinção explícita de escopo no texto/teste e confirmado GREEN (8/8). A revisão técnica e comercial subsequente aprovou a resolução sem bloqueantes.

## Finding tardio — TOCTOU do alvo NEWAVE na migration 0130

- Revisão técnica independente reprovou a migration 0130 apontando condição de corrida entre `count(*)` de `agent_configs` e o `SELECT ... FOR UPDATE` seguinte: uma inserção concorrente entre os dois statements faria o `SELECT INTO` (sem `STRICT`, sem `ORDER BY`) escolher uma linha arbitrária em vez de rejeitar a ambiguidade.
- Investigação independente confirmou o finding como real: `agent_configs` não tem `UNIQUE(tenant_id)` (`0001_core.sql:20-29`); o índice único de `tenants.slug` (`0017_saas_foundation.sql:1-9`) garante um tenant, não uma configuração; os advisory locks de `migration-runner.ts:135` e `provision-newave.ts:28` não são compartilhados nem bloqueiam INSERTs normais (`modules/root/routes.ts:126-130`).
- TDD: RED real de PostgreSQL adicionado ao harness executa a migration completa em transação aberta e exige que um INSERT concorrente de segundo `agent_config` no mesmo tenant falhe com `lock_timeout` `55P03`. RED: 8 passaram / 1 falhou (INSERT concluiu, código `null`).
- GREEN mínimo na migration 0130: `SELECT id INTO v_tenant_id FROM tenants WHERE slug = 'newave-ia' FOR UPDATE` (o lock da linha-pai conflita com o `KEY SHARE` exigido pela FK do INSERT concorrente) e `SELECT a.id INTO STRICT v_agent_id ... FOR UPDATE` em bloco `EXCEPTION` aninhado, com `NO_DATA_FOUND` mantendo o no-op e `TOO_MANY_ROWS` mantendo a exceção de alvo ambíguo. `v_agent_count` removido; nenhum byte do prompt alterado.
- Revisão técnica final da correção: APROVADO sem bloqueantes. Revisão de qualidade do teste apontou um bloqueante de harness (possível vazamento do `migrator` se a segunda `pool.connect()` falhasse antes do `try/finally`); corrigido com aquisição em `try/finally` aninhado, sem alterar a asserção `55P03`.
- Evidências pós-correção: teste NEWAVE 9/9 repetido três vezes; NEWAVE + fresh migrations 18/18; `npm run typecheck` e `npm run build` exit 0; `git diff --check` no escopo exit 0; teste com 239 linhas; hashes de prefixo, seção 26 e `comments.md` inalterados; bloco Markdown/SQL ainda idêntico.
