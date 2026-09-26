# Google Calendar ↔ AtendON (2026-09-24)

Objetivo: agendas por atendente, mapeamento por pipeline/equipe, eventos sincronizados e disponibilidade Google sem usar a conta global do Google Meet existente. Não alterar as credenciais ou comportamento legado do Meet. Sem deploy/commit nesta tarefa.

## Persistência (migration 0185_google_calendar_team.sql)

- `scheduling_calendar_connections`: id UUID PK, tenant_id UUID, member_id UUID, google_email TEXT, refresh_token_encrypted TEXT (nunca em JSON/log), calendar_id TEXT NULL, calendar_name TEXT NULL, calendar_timezone TEXT NULL, connected_at TIMESTAMPTZ, created_at/updated_at. UNIQUE(tenant_id,member_id), UNIQUE(id,tenant_id); FKs tenant e (member_id,tenant_id)→workspace_members(id,workspace_id) ON DELETE CASCADE. Só calendar_id selecionado habilita sincronização. Não confundir com Google Meet settings.
- `scheduling_pipeline_calendar_routes`: tenant_id,pipeline_id PK composta; team_id nullable, connection_id nullable; exatamente um não-nulo; FKs com tenant para pipelines, teams, connections. Rota sem configuração → assignee do AtendON e conexão desse assignee, se houver; equipe → escolher entre seus membros; conexão → assignee do dono da conexão.
- `scheduling_appointment_calendar_events`: appointment_id PK, tenant_id, connection_id, calendar_id, event_id, etag, last_synced_at, sync_error, UNIQUE(connection_id,calendar_id,event_id); FK composta appointment e connection ao tenant. Guarda vínculo sem atribuir ownership de evento externo arbitrário.
- `scheduling_calendar_sync_outbox`: appointment_id PK + tenant_id, kind enum/check upsert/delete, available_at, attempts, last_error, claim timestamp; FK tenant+appointment, índices pendentes. Escritas de appointment enfileiram na MESMA transação; cancelamento NÃO apaga vínculo até exclusão remota confirmada.
- OAuth anti-CSRF nonce one-time persistido em tabela `scheduling_calendar_oauth_states` (id/nonce,tenant_id,user_id,member_id,expires_at,used_at); callback exige sessão e consome nonce atomicamente, mesmo após erro OAuth. Use scopes de eventos, freebusy e calendarList; tokens em AES-GCM com DATA_ENCRYPTION_KEY, never log token/code.

## Contrato HTTP

- GET `/scheduling/google-calendar/connections`: listar só metadados e calendários escolhidos; `configured` boolean, `connections[]` com member_id, email, calendar_id/name/timezone e id.
- GET `/scheduling/google-calendar/oauth/start?member_id=<uuid>`: `authorization_url`; exigir `units.manage` e membro ativo do tenant (self pode ser adicionado numa iteração posterior; sem permissão não conecta por outro).
- GET `/scheduling/google-calendar/oauth/callback?code&state`: cookie de sessão, validar nonce/usuário/tenant, trocar código, `userinfo` verificado, cifrar refresh token e salvar conexão ainda SEM agenda selecionada; redirect seguro para `/configuracoes/google-calendar?calendar_oauth=connected|error|denied`.
- GET `/scheduling/google-calendar/connections/:id/calendars`: somente calendários writer/owner da conta (incluindo primary), com timezone, nome, primary; paginação completa da API; nunca aceitar ID arbitrário para vincular.
- PUT `/scheduling/google-calendar/connections/:id/calendar`: `{calendar_id}` presente na lista com write access; persistir e criar sync inicial. DELETE `/scheduling/google-calendar/connections/:id`: desconectar somente conta escolhida; não usar nem apagar token global do Meet.
- GET/PUT `/scheduling/google-calendar/routes`: routes por pipeline; PUT `{pipeline_id,team_id?,connection_id?}` valida ownership; DELETE `/scheduling/google-calendar/routes/:pipelineId` remove o override. Permissão de leitura `units.read`, escrita `units.manage`.

## Sincronização

- `GoogleCalendarClient`: usa endpoints Google oficiais com `redirect:'error'`, timeout, refresh offline. List calendars via calendarList pagination; freeBusy retorna falha fechada para erro de calendário; events insert/patch/delete/get com etag If-Match; idempotência por event ID determinístico derivado de appointment UUID + identificador de app (formato aceito pela API) ou recuperação por extendedProperties.private.atendon_appointment_id antes de retry. Escopo calendars `calendar.events calendar.calendarlist.readonly calendar.freebusy openid email` (verificar conjunto exato nos docs). Sem `conferenceData.createRequest`: a sincronização nunca pede Meet ao Google — quando há reunião (AtendON Meet ou Google Meet legado), o `meeting_url` provisionado já vai na descrição do evento, sem substituir o link existente. `events.insert` é `POST /calendar/v3/calendars/{calendarId}/events` com o `id` determinístico no corpo do JSON (nunca no path); `patch/get/delete` usam `/calendars/{calendarId}/events/{eventId}`.
- Bloqueio em `createAppointment`, `rescheduleAppointment`, troca de responsável e consulta de disponibilidade para a conexão selecionada; sobreposição intervalar + buffer configurável por agenda, timezone IANA e end explícito. Se Google indisponível, não confirmar horário como livre. Na ausência de conexão ativa, manter lógica existente.
- No commit da criação/reagendamento/cancelamento/transferência, outbox na mesma transação; worker drena outbox com retry/backoff e status observável, sem gravar token em logs. Não sincronizar eventos de terceiros para leads; terceiros apenas bloqueiam disponibilidade. Alterações de eventos vinculados no Google devem refletir no AtendON por polling incremental/GET com etag e proteção contra conflitos; nunca mover evento externo desconhecido. Ao desconectar, preservar appointments e marcar vínculos órfãos para evitar escrita com credencial de outra pessoa.

## Aceite

- Testes automatizados de OAuth CSRF/replay/tenant, conexão A/B isolada, calendário inválido/sem writer, conflito busy/buffer/timezone, criação/reagendamento/cancelamento e mudança de responsável, reconciliação e falhas/retries, Google Meet sem regressão, painel conectando e escolhendo calendário/rotas.
- Typecheck, testes focados, suíte relevante e build; não solicitar login Google real nem credenciais via chat. Integração real com conta Google só poderá ser validada após credenciais OAuth e consentimento humano.
