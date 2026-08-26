# SPEC: Módulo de Follow-ups, mídia e remoção de funcionalidades

## Objective
Consolidar a configuração de follow-ups da IA e sua biblioteca de mídia em `/follow-ups`, migrar as figurinhas para esse módulo, adicionar áudio como mensagem de voz nativa e remover integralmente as funcionalidades de Melhoria da IA e Chaves de API, sem deixar rotas, permissões, jobs ou código órfão.

## Source
comments.md

Itens 11, 15 e 17:
- áudio OGG/MP3 anexado ao follow-up, entregue como áudio novo/PTT;
- remoção de `/agente/melhorias` e `/workspace/api-keys`;
- migração de `/agente/figurinhas` para `/follow-ups`, incluindo imagens, vídeos, áudios e figurinhas.

## Current State
- O painel possui `apps/panel/app/agente/melhorias/page.tsx` e `improvement-console.tsx`, e `apps/panel/app/workspace/api-keys/page.tsx`. A página de melhorias consome a família `/agent/*`; a de chaves consome `/workspaces/current/api-keys` e exige `api_keys.read/manage`.
- O catálogo de navegação é centralizado em `apps/panel/lib/panel-manifest.ts`; o `Shell` (`apps/panel/components/shell.tsx`) deriva menu, paleta, item ativo e controle de acesso desse catálogo. As rotas citadas não aparecem hoje no trecho atual do manifest, mas a remoção deve incluir referências históricas, guards e descoberta de rota.
- Figurinhas estão em `apps/panel/app/agente/figurinhas/page.tsx`, com upload WebP até 1 MB, edição/ativação/exclusão e conteúdo autenticado. Backend: `apps/backend/src/modules/stickers/routes.ts` (`GET/POST/PATCH/DELETE /ai-stickers` e `/content`) e `repository.ts`; registradas por `registerStickerRoutes` em `apps/backend/src/app.ts`. A importação de figurinha enviada pelo WhatsApp ocorre em `app.ts`/webhook e usa `downloadMedia`.
- Já existe base de follow-up: `apps/backend/src/app.ts` expõe `/ai-follow-ups/settings` e `/ai-follow-ups/media` (lista, conteúdo, upload e remoção); `apps/backend/src/modules/messages/follow-up-media.ts` aceita somente JPEG/PNG/WebP e descreve assets; `apps/backend/src/modules/messages/ai-follow-up.ts` faz claim, valida contexto, seleciona delivery, chama gateway e persiste mensagens; `apps/backend/src/queue/ai-follow-up-queue.ts` usa BullMQ; o worker/reconciliador processa a fila. A migration `0042_ai_follow_ups.sql` cria configurações/agendas e `0066_ai_follow_up_media.sql`/`0067_ai_follow_up_media.sql` criam delivery, assets e índices (a numeração encontrada inclui `0067` para a tabela).
- `ai_follow_up_delivery` atualmente suporta somente `text`, `image` e `sticker`; `selectedDelivery`, `validateDelivery`, `followUpSystemPrompt`, `claimDue` e `completeSent` precisam ser estendidos para áudio/vídeo.
- O provider real é Evolution API: `apps/backend/src/modules/whatsapp/evolution-client.ts`. O caminho atual de áudio chama `POST /message/sendWhatsAppAudio/{instance}` com `{ number, audio }`, sem `ptt`; imagens/documentos usam `/message/sendMedia` com `mediatype`, `mimetype`, `media`, `fileName` e `caption`. O gateway é `MessageGateway` em `apps/backend/src/modules/messages/types.ts`, adaptado por `session-manager.ts`.
- Mensagens são persistidas na tabela `messages` (`0001_core.sql`) com `media_type` (`audio|image|document`), MIME, nome e tamanho. O webhook Evolution identifica `audioMessage` em `evolution-webhook.ts`; hoje o áudio recebido pode ser enriquecido por jobs/repository, e o nome de arquivo deve ser ocultado na apresentação (item inicial de `comments.md`).
- Melhorias de IA têm backend amplo: `apps/backend/src/modules/agent-improvement/{routes,versions,proposals,evaluator,replay-runner,evaluation-events,evaluation-event-processor,operations,publication-authorization}.ts`, imports/registro em `app.ts`, workers e filas `ai-evaluation-queue.ts`/`ai-replay-queue.ts`; tabelas e constraints nas migrations `0051_ai_improvement_cycle.sql`, `0053_ai_evidence_cleanup.sql`, `0055_ai_proposal_evidence_tenant_guard.sql` e relacionadas.
- Chaves têm `apps/backend/src/modules/workspaces/api-keys.ts`, registro em `modules/workspaces/routes.ts`, autenticação em `apps/backend/src/auth/api-key.ts`, permissões em `auth/rbac.ts`, capability gate em `capabilities/gate.ts`, auditoria/logger e tabelas `tenant_api_keys` nas migrations `0006_scheduling.sql`, `0037_tenant_api_key_security.sql`, `0061_core_tenant_integrity.sql`, além de seed/provisionamento.

## Desired Behavior
`/follow-ups` é a única área do painel para configurar cadência/delivery e administrar uma biblioteca por workspace de imagens, vídeos, áudios e figurinhas. A seleção de cada tentativa pode ser texto, imagem com legenda, vídeo, figurinha ou áudio. Áudios OGG/MP3 são normalizados para OGG/Opus compatível e enviados pela Evolution como voice note/PTT, sem documento, sem encaminhamento e sem expor nome de arquivo ao contato.

## Requirements
### R1
Remover Melhoria da IA integralmente.

Acceptance Criteria:
- `/agente/melhorias` não existe nem é descoberto pelo Next; retorno é 404/rota não encontrada.
- Todas as rotas `/agent/improvement-*` e equivalentes deixam de ser registradas; imports, serviços, schemas, auditoria, capability, permissões e chamadas em `app.ts`, `worker.ts`, filas e provisionamento são removidos.
- Nenhum texto/import/referência executável a `agent-improvement`, `ai-improvement`, `AI_REPLAY_QUEUE` ou `ai_improvement_*` permanece fora de migrações históricas explicitamente documentadas.
- Dados existentes: por decisão destrutiva, criar migration de remoção das tabelas/constraints/índices de melhoria (`ai_improvement_proposals`, `ai_evaluation_runs`, `ai_evaluation_case_results`, `ai_regression_cases`, `ai_attendance_evaluations` e objetos relacionados), após backup operacional; risco: perda irreversível de histórico/auditoria e dependências FK em versões de agente. A migration deve falhar claramente se houver dependência não prevista, e o runbook deve registrar backup e contagem antes/depois.

Verification:
- `grep` de rotas/imports e teste HTTP de cada endpoint removido;
- inspeção da migration e consulta de catálogo PostgreSQL após aplicação;
- `npm run typecheck`, `npm run lint`, `npm test` e `npm run build`.

### R2
Remover Chaves de API integralmente, incluindo autenticação pública.

Acceptance Criteria:
- `/workspace/api-keys` e `/workspaces/current/api-keys` (GET/POST/rotate/DELETE) não existem.
- Remover `api_keys.read/manage`, bindings de papéis/seed, capability gate, `auth/api-key.ts`, logger de `x-api-key` e documentação/testes específicos; nenhum endpoint aceita `x-api-key` como autenticação.
- Decisão destrutiva: migration remove `tenant_api_keys`, índices, triggers e constraints após backup; risco explícito de quebrar integrações externas que ainda usam as chaves. O deploy deve oferecer inventário/contagem e janela de comunicação, mas não preservar endpoint legado.

Verification:
- testes negativos de rota e autenticação com `x-api-key`;
- busca de referências e verificação de permissões no banco;
- comandos npm completos.

### R3
Criar o módulo `/follow-ups` e migrar a interface de figurinhas.

Acceptance Criteria:
- Nova página/menu/paleta aparece no grupo de administração/workspace somente para o mesmo escopo hoje protegido por `requireRootWorkspace`; isolamento por `tenantId` é mantido em toda leitura, conteúdo, seleção e remoção.
- A tela reúne configurações/cadência atuais, delivery por tentativa e biblioteca CRUD de imagem, vídeo, áudio e figurinha.
- `/agente/figurinhas` deixa de ser página funcional: preferencialmente redirect 308 para `/follow-ups`; nenhuma segunda UI/endpoint específico é mantido. APIs de sticker são absorvidas/rebatizadas para contrato da biblioteca, ou mantidas apenas como camada interna sem rota pública duplicada.
- Upload valida MIME, extensão, assinatura/magic bytes, tamanho e hash; conteúdo é privado/autenticado; assets em uso não podem ser removidos.

Verification:
- teste de navegação/redirect, permissão root workspace e cross-tenant;
- testes de CRUD para cada tipo de mídia e de asset inexistente/em uso;
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.

### R4
Expandir delivery e persistência de follow-up para mídia.

Acceptance Criteria:
- Schema discriminado inclui `{type:"text"}`, `{type:"image",assetId}`, `{type:"video",assetId}`, `{type:"sticker",assetId}` e `{type:"audio",assetId}`; cada posição corresponde exatamente a uma janela de `delaysMinutes`.
- Migration adiciona `description`/metadados necessários e permite MIME seguro de vídeo e áudio; assets e `messages` preservam tenant, MIME, tamanho e external/provider id.
- `follow-up-media.ts`, `ai-follow-up.ts`, `types.ts`, repository e rotas validam que cada asset existe no mesmo tenant e está habilitado quando aplicável; claim carrega bytes e completeSent grava o tipo correto.
- Vídeo usa `/message/sendMedia` como `mediatype:"video"`; nunca cai silenciosamente para documento.

Verification:
- testes unitários de schema/tenant/seleção e integração da fila com cada delivery;
- testes de persistência idempotente e cancelamento quando conversa muda;
- verificar que o job BullMQ e reconciliador continuam processando agendas existentes.

### R5
Enviar áudio anexado como mensagem de voz nativa/PTT.

Acceptance Criteria:
- Upload aceita `.ogg`, `.mp3` e MIME correspondente, com limite documentado; MP3 e OGG não-Opus são convertidos no backend para OGG container + Opus mono (sample rate compatível, usando ffmpeg/libav ou conversor aprovado), com validação do resultado e limpeza de temporários.
- `EvolutionClient.sendMedia`/contrato do gateway recebe `mediaType:"audio"` e envia `POST /message/sendWhatsAppAudio/{instance}` com `number`, `audio` base64 e o campo booleano de PTT exigido pela versão instalada da Evolution API (normalmente `ptt: true`; confirmar no contrato/container `deploy/evolution` antes de implementar). Se a versão exigir endpoint/payload diferente, adaptar o provider real, não usar `/message/sendMedia`/`mediatype:"document"`.
- O áudio não contém caption/nome no payload; `fileName` não é enviado ao contato. A mensagem persistida tem `media_type='audio'`, MIME final `audio/ogg; codecs=opus` (ou valor aceito pelo provider), tamanho e id externo.
- Teste end-to-end verifica no payload capturado `ptt:true`, endpoint `sendWhatsAppAudio`, ausência de `fileName`/documento e presença de waveform/voice-note no evento de retorno ou evidência equivalente do provider.

Verification:
- testes unitários de normalização MP3/OGG/Opus, assinatura, duração/limite e falha de codec;
- teste do `EvolutionClient` capturando URL e JSON;
- integração com webhook verificando `audioMessage`/PTT e UI sem nome de arquivo;
- teste real contra Evolution em ambiente de integração, se disponível.

### R6
Retirar nomes de arquivo da experiência do contato e da UI quando mídia for áudio.

Acceptance Criteria:
- Texto apresentado em conversa para áudio é “Mensagem de áudio” (ou equivalente), nunca `audio-...`, `fileName` ou caminho interno.
- Logs/auditoria não registram base64 nem segredo; metadados permitidos não incluem conteúdo.

Verification:
- testes de renderização e busca por template de nome de áudio nas respostas de conversa;
- teste de redaction dos logs.

## Invariants
- Todo acesso e FK de mídia/follow-up é escopado por `tenant_id`; nenhum asset de outro workspace pode ser lido, associado ou enviado.
- Claims são idempotentes por conversation/sequence/provider key, cancelam com nova mensagem do contato e respeitam lock, lease e limites atuais.
- Mensagem de voz nunca é documento nem encaminhada; o provider é Evolution API, não Baileys/WPPConnect direto.
- Não remover `openrouter_api_key_encrypted` de `tenant_ai_settings`: é credencial interna da IA e não a funcionalidade pública de chaves de workspace.

## Edge Cases
- OGG válido porém codec não Opus; MP3 com MIME incorreto; arquivo malicioso com extensão válida; duração/tamanho acima do limite; ffmpeg ausente ou conversão interrompida.
- Evolution rejeita `ptt`, versão incompatível, sessão desconectada ou retorna id ausente: marcar falha/retry conforme política existente, sem registrar mensagem como enviada.
- Asset removido/desativado entre configuração e claim; tenant trocado durante request; duas alterações concorrentes de settings; job duplicado/lease expirado.
- Migração destrutiva encontra FK de `agent_config_versions` para proposta ou integração usando API key: abortar antes de DROP e exigir decisão operacional explícita.

## Dependencies
- Contrato/versão da Evolution API instalada em `deploy/evolution` e disponibilidade de codec ffmpeg/libav.
- PostgreSQL migrations runner, Redis/BullMQ, storage BYTEA atual e permissões de workspace.
- Dados de produção: backup e inventário antes das migrations destrutivas.

## Affected Areas
- Frontend: `apps/panel/app/agente/{melhorias,figurinhas}`, `apps/panel/app/workspace/api-keys`, nova `apps/panel/app/follow-ups`, `apps/panel/lib/panel-manifest.ts`, `apps/panel/components/shell.tsx`, libs/tests de follow-up.
- Backend: `apps/backend/src/app.ts`, `worker.ts`, `modules/messages/{ai-follow-up,follow-up-media,repository,types}.ts`, `modules/stickers/*`, `modules/agent-improvement/*`, `modules/workspaces/{routes,api-keys}.ts`, `auth/{rbac,api-key}.ts`, `capabilities/gate.ts`, `modules/whatsapp/{evolution-client,evolution-webhook,session-manager}.ts`, queues, seed/provisionamento.
- Banco: migrations `0001`, `0006`, `0037`, `0042`, `0051`, `0053`, `0055`, `0059`, `0060`, `0061`, `0066`, `0067`, `0068` e nova migration de mídia/remoção.
- Testes: `apps/backend/tests/{api-keys,ai-follow-up,evolution-client,evolution-webhook}.test.ts` e integrações; `apps/panel/tests/ai-follow-ups.test.ts` e testes de páginas/menu.

## Non-goals
- Não alterar cadência, prompt, critérios de elegibilidade, humanizer ou status comercial além do necessário para suportar delivery.
- Não criar gravação de áudio no navegador; somente anexar arquivo.
- Não manter compatibilidade pública de API keys nem implementar outro provider WhatsApp.
- Não apagar credenciais internas da IA em `tenant_ai_settings`.

## Constraints
- DECISÃO DE ESCOPO (orquestrador, Phase 4): as migrations destrutivas (`DROP TABLE`
  de `ai_improvement_*`, `ai_evaluation_*`, `ai_regression_cases`,
  `ai_attendance_evaluations`, `tenant_api_keys`) devem ser ESCRITAS como arquivo
  de migration novo, mas NÃO aplicadas nem incluídas no runner automático nesta
  rodada. Motivo: o usuário proibiu deploy e a perda de dados é irreversível por
  rollback SQL. Entregue o arquivo `.sql` com um cabeçalho comentado explicando o
  gate e registre em `progress.md` que a aplicação está pendente de aprovação.
  A remoção de CÓDIGO (rotas, UI, permissões, jobs, testes) é feita integralmente
  nesta rodada — apenas o DROP dos dados fica represado.
- Multi-tenant obrigatório; validar fronteiras com Zod e magic bytes.
- Não enviar `fileName` no payload de áudio e não usar documento como fallback silencioso.
- Migrações destrutivas somente após backup/inventário e com rollback operacional documentado; DROP de dados não é reversível por rollback SQL.
- Executar `npm test`, `npm run lint`, `npm run typecheck` e `npm run build` após implementação.

## Required Tests
- Unitários: schemas, MIME/signatures, codec, PTT payload, delivery selection, tenant isolation, idempotência.
- Backend HTTP: 404 em rotas removidas, ausência de `x-api-key`, CRUD `/follow-ups`, auth/tenant, assets em uso.
- Worker/integration: text/image/video/sticker/audio, cancelamento/lease/retry e persistência `messages`.
- Evolution/webhook: endpoint e `ptt:true`, evento de áudio nativo, ausência de documento/nome.
- Panel: menu/paleta/redirect, permissões, upload e estados loading/error.
- Regressão: `npm test`; `npm run lint`; `npm run typecheck`; `npm run build`.

## Definition of Done
- [ ] `/agente/melhorias` e `/workspace/api-keys` removidos no frontend, backend, menu, permissions, guards, jobs e testes.
- [ ] Backup/inventário e migrations destrutivas de tabelas de melhorias/API keys aprovados e verificados.
- [ ] `/follow-ups` reúne settings, delivery e biblioteca de quatro tipos com isolamento por workspace.
- [ ] `/agente/figurinhas` redireciona ou inexiste, sem endpoint/UI órfão.
- [ ] MP3/OGG chega convertido/validado como OGG/Opus e payload Evolution contém PTT verdadeiro.
- [ ] Áudio não é documento/encaminhamento e nome de arquivo não aparece para o contato.
- [ ] Testes unitários, integração, UI e comandos npm obrigatórios passam.
- [ ] Contrato da versão real da Evolution API para `ptt` foi confirmado e documentado no código/teste.
