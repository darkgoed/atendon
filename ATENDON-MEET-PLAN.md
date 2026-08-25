# AtendON Meet — videochamada própria com gravação

## Contexto

Hoje o AtendON só sabe agendar reuniões via Google Meet (`apps/backend/src/modules/scheduling/google-meet.ts`), dependendo de OAuth por tenant, da API do Google, e sem nenhuma forma de gravar a chamada. O objetivo é o AtendON ter seu próprio "Meet" — quase completo (multi-participante, chat, compartilhar tela, sala protegida) — com gravação de reunião, reduzindo a dependência externa e permitindo controlar o dado da gravação.

Decisão validada com o usuário: em vez de construir um motor de videochamada do zero (SFU, sinalização, UI), self-hostar **Jitsi Meet** (open source, já traz UI completa) com **Jibri** para gravação server-side. Gravações ficam em **disco local no VPS** (bind mount), com retenção automática — o VPS já não tem storage de objeto (S3/MinIO) hoje, e adicionar um serviço novo só para isso não se justifica agora.

Levantamento feito no repo (não precisa re-explorar):
- Stack: Fastify + TypeScript + Postgres + Redis + BullMQ no `apps/backend`; Next.js no `apps/panel`; PM2 roda backend/worker/panel **no host**, não em Docker — só infra (`postgres`, `redis`, `evolution-*`) está no `docker-compose.yml` da raiz.
- `scheduling_appointments` já tem colunas `meeting_provider`/`meeting_space_name`/`meeting_code`/`meeting_url`/`meeting_created_at` com CHECK travado em `'google_meet'` (migration `0043_google_meet_scheduling.sql`) — é o template exato a estender.
- Auth de sessão via JWT (`jose`) em `apps/backend/src/auth/session.ts` (`requireIdentity`, `requireWorkspace`), segredo `config.JWT_SECRET`.
- Sem WebSocket próprio (só SSE unidirecional) — não é problema, pois o Jitsi traz sua própria sinalização (XMPP via Prosody/JVB).
- Sem GPU no VPS; Jibri grava via Chrome headless + ffmpeg (CPU).
- Disco em ~69% de uso, ~31GB livres — retenção curta é necessária.
- Última migration aplicada: `0118_dynamic_capability_catalog.sql` → próxima é `0119`.

## Abordagem

### 1. Infra Docker
Novo arquivo `docker-compose.jitsi.yml` (separado do compose principal, deploy independente):
`docker compose -f docker-compose.yml -f docker-compose.jitsi.yml up -d`

Imagens oficiais `jitsi/web`, `jitsi/prosody`, `jitsi/jicofo`, `jitsi/jvb`, `jitsi/jibri` — a config de Prosody/Jicofo/JVB é gerada pelo entrypoint das próprias imagens via env vars, não escrever isso à mão.

- `jitsi-web`: publica só em `127.0.0.1:8444:80` (mesmo padrão loopback-only de `postgres`/`redis`/`evolution-api` no compose atual). TLS fica no nginx do host (`DISABLE_HTTPS=1`).
- `jitsi-prosody`/`jitsi-jicofo`: sem porta pública, rede interna do compose.
- `jitsi-jvb`: precisa `DOCKER_HOST_ADDRESS=<IP público do VPS>` e publicar `10000:10000/udp` **direto no host** (RTP não passa por nginx — abrir a porta no firewall do VPS, ex. `ufw allow 10000/udp`).
- `jitsi-jibri`: sem porta pública, `privileged: true` (exigido pela imagem por causa de X11/ffmpeg), limites de recursos (`cpus`, `mem_limit`) para não deixar uma gravação saturar o VPS.
- Gravações: **bind mount** para diretório do host (`./data/meet-recordings:/config/recordings`), não named volume — porque backend/worker rodam via PM2 fora do Docker e precisam ler o arquivo direto do filesystem.

Env vars novas (`JITSI_*`) no `.env`: `PUBLIC_URL`, `DOCKER_HOST_ADDRESS`, `AUTH_TYPE=jwt`, `JWT_APP_ID`, `JWT_APP_SECRET`, `JWT_ACCEPTED_ISSUERS/AUDIENCES`, `ENABLE_GUESTS=0`, `ENABLE_RECORDING=1`, credenciais internas XMPP (`JICOFO_*`, `JVB_*`, `JIBRI_*`).

### 2. Nginx
Subdomínio dedicado `meet.atendon.alpdash.com.br` (path-based quebraria URLs internas fixas do bundle Jitsi tipo `/http-bind`). Novo `server{}` em `deploy/nginx/atendon.conf` (mesmo padrão de vhost já usado), cert via `certbot --nginx -d meet.atendon.alpdash.com.br`, proxy `location /` → `127.0.0.1:8444`, headers de upgrade (WebSocket) e `proxy_read_timeout 1h` (BOSH é long-polling, igual já feito em `/api/events`).

No domínio principal (painel), adicionar `frame-src https://meet.atendon.alpdash.com.br` ao CSP — hoje não existe essa diretiva, então cai em `default-src 'self'` e bloquearia o iframe.

### 3. Auth / token de sala
Novo segredo isolado `MEET_JWT_SECRET` (não reusar `JWT_SECRET` de sessão — mesmo padrão de segredos dedicados que `config.ts` já valida não colidirem). Duas rotas de emissão:
- `GET /meet/rooms/:id/token` (atrás de `requireWorkspace`) → JWT de **moderador** (TTL curto, ~2h).
- `GET /meet/join/:code` (pública, rate-limited) → JWT de **participante** (lead recebido via WhatsApp, sem login no AtendON).

Claims mínimas para `mod_auth_token`/lib-jitsi-meet: `iss`/`aud`=`JWT_APP_ID`, `room` escopado à sala (nunca `'*'`), `exp` curto, `context.user`. Validar a claim exata de moderador contra a versão fixada das imagens antes de codar (varia entre versões).

### 4. Backend — novo módulo `apps/backend/src/modules/meet/`
`routes.ts`, `service.ts`, `jitsi-token.ts` (fase 1); `recordings-indexer.ts`, `retention.ts` (fase 2). Registrar em `app.ts` com `void app.register(registerMeetRoutes);`, mesmo padrão das ~15 rotas já registradas ali.

**Sem outbox.** Criar sala Jitsi é gerar um `room_name` e assinar um JWT local — sem I/O de rede externo, sem falha parcial. Diferente do Google Meet (API externa), não precisa do padrão de lease/retry de `meeting-provisioning.ts`.

**Sem rota de start/stop de gravação.** O botão nativo "Start recording" da toolbar Jitsi já dispara o Jibri via XMPP quando a claim `features.recording` está no JWT do moderador — não reimplementar isso via IQ/XMPP customizado.

Rotas: `POST /meet/rooms`, `GET /meet/rooms/:id/token`, `GET /meet/join/:code`, e (fase 2) `GET /meet/recordings?appointment_id=`, `GET /meet/recordings/:id/file` (stream, mesmo padrão de `tripz-ai/routes.ts:255`).

Jobs BullMQ recorrentes no worker (fase 2, `repeat: {...}` — feature nativa do BullMQ já instalado): indexador (varre `MEET_RECORDINGS_DIR` a cada 5min, casa com `meet_rooms`, popula `meet_recordings`) e expurgo diário (`created_at < now() - MEET_RECORDING_RETENTION_DAYS`, default 30).

### 5. Integração com scheduling (mudança cirúrgica)
Migration expande o CHECK de `meeting_provider` para aceitar `'atendon_meet'` e cria `scheduling_atendon_meet_settings` (clone de `scheduling_google_meet_settings` sem os campos OAuth). No ponto de `service.ts` onde hoje se decide criar Google Meet ao confirmar appointment: checar `scheduling_atendon_meet_settings.enabled` primeiro; se true, provisionar sala Jitsi inline na mesma transação (reusa as colunas existentes `meeting_provider`/`meeting_space_name`/`meeting_url`/etc, sem coluna nova); senão, cai no fluxo Google Meet sem alterá-lo.

**`tool-executor.ts`/`agendar_reuniao` não muda** — já chama `createQualifiedMeetingAppointment`, que é onde o branch de provider vive. A IA não precisa saber qual provider foi usado.

### 6. Painel (`apps/panel`)
- `apps/panel/app/meet/[roomId]/page.tsx` (autenticado) e rota equivalente para o link do lead (`/reuniao/[code]`): client component carregando `https://meet.atendon.alpdash.com.br/external_api.js` + `JitsiMeetExternalAPI`, branding via `interfaceConfigOverwrite`/`configOverwrite` (sem rebuildar a imagem `jitsi/web`).
- Config do tenant: clonar `GoogleMeetSettingsPanel` (em `apps/panel/app/configuracoes/page.tsx`, ~linha 306) como `AtendonMeetSettingsPanel` — só um toggle `enabled`, sem fluxo OAuth.
- Gravações (fase 4): seção "Gravações" em `apps/panel/app/agenda/agenda-detail-dialog.tsx` quando `meeting_provider === 'atendon_meet'`. Sem página de catálogo geral — YAGNI até pedirem.

### 7. Migração de banco
`apps/backend/src/db/migrations/0119_atendon_meet.sql`, no formato exato de `0043_google_meet_scheduling.sql`:
- Expande os dois CHECKs de `scheduling_appointments` (`meeting_provider`, `meeting_fields`) para aceitar `'atendon_meet'` além de `'google_meet'`.
- `scheduling_atendon_meet_settings(tenant_id PK, enabled, created_at, updated_at)`.
- `meet_rooms(id, tenant_id, room_name UNIQUE, appointment_id, created_at)` + índice por tenant.
- `meet_recordings(id, tenant_id, room_name, appointment_id, file_path, size_bytes, started_at, ended_at, status, created_at)` (fase 2) + índice `(tenant_id, created_at DESC)`.

### 8. Fases de entrega (cada uma isolada e demo-ável)
1. **Jitsi standalone atrás de auth** — compose, nginx, `MEET_JWT_SECRET`, `POST /meet/rooms` + `GET /meet/rooms/:id/token`, tabela `meet_rooms`, página `/meet/[roomId]`. Um usuário logado cria sala e chama outro logado. Sem gravação, sem scheduling.
2. **Gravação** — `jitsi-jibri` no compose, bind mount, `features.recording` no JWT, indexador + `meet_recordings` + retenção.
3. **Integração scheduling/IA** — migration do CHECK + `scheduling_atendon_meet_settings` + branch em `service.ts` + painel de config.
4. **UI de gravações no agendamento** — seção em `agenda-detail-dialog.tsx` + streaming de arquivo.

## Riscos reais
- **CPU do Jibri**: sem GPU, cada gravação ativa é Chrome headless + ffmpeg full-time; 2-3 gravações simultâneas podem degradar todas as chamadas do VPS. Medir na prática antes de anunciar "sempre grava".
- **Disco cheio**: 31GB livres, retenção diária não é reativa — um pico de uso simultâneo pode estourar disco antes do expurgo rodar.
- **Complexidade operacional**: Prosody+Jicofo+JVB+Jibri é um sistema distribuído com estado próprio; hoje a equipe não opera XMPP. Maior risco do plano é operacional, não o código.
- **Porta UDP em firewall**: primeira porta não-HTTP exposta assim no ambiente — se bloqueada silenciosamente, a chamada conecta mas sem áudio/vídeo, difícil de diagnosticar sem acesso à rede do VPS.

## Arquivos críticos
- `docker-compose.yml` (padrão de serviço/porta loopback a seguir)
- `deploy/nginx/atendon.conf` (novo vhost `meet.` + CSP `frame-src`)
- `apps/backend/src/auth/session.ts` (`requireWorkspace`/`requireIdentity`)
- `apps/backend/src/modules/scheduling/service.ts` (branch de provider, próximo de `loadGoogleMeetSettings`)
- `apps/backend/src/db/migrations/0043_google_meet_scheduling.sql` (template da migration `0119`)
- `apps/backend/src/app.ts` (registro de `registerMeetRoutes`)
- `apps/backend/src/worker.ts` (jobs repeatable de indexação/retenção)
- `apps/panel/app/configuracoes/page.tsx` (clonar `GoogleMeetSettingsPanel`)
- `apps/panel/app/agenda/agenda-detail-dialog.tsx` (seção de gravações)

## Verificação
- **Fase 1**: subir `docker compose -f docker-compose.yml -f docker-compose.jitsi.yml up -d`, confirmar `jitsi-web`/`prosody`/`jicofo`/`jvb` saudáveis (`docker ps`), acessar `https://meet.atendon.alpdash.com.br` direto (deve pedir token/dar erro de auth, confirmando `AUTH_TYPE=jwt` ativo); logar no painel, criar sala via `POST /meet/rooms`, abrir `/meet/[roomId]` em duas sessões (uma normal, uma anônima simulando o lead via `/join/:code`) e confirmar áudio/vídeo bidirecional.
- **Fase 2**: iniciar gravação pelo botão nativo na sala de teste, encerrar, confirmar arquivo aparece em `data/meet-recordings/`, esperar o job indexador rodar (ou disparar manualmente) e confirmar linha em `meet_recordings`; rodar job de retenção manualmente com `MEET_RECORDING_RETENTION_DAYS=0` numa gravação de teste e confirmar exclusão de arquivo + linha.
- **Fase 3**: `npm run build && npm test` no backend (migração + testes de scheduling), ativar `scheduling_atendon_meet_settings.enabled=true` num tenant de teste, confirmar via `agendar_reuniao` (ou endpoint direto) que o appointment sai com `meeting_provider='atendon_meet'` e `meeting_url` populado.
- **Fase 4**: abrir agendamento com gravação associada no painel, confirmar listagem e reprodução/download do arquivo.
