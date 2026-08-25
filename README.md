# AtendON

Operação do ciclo supervisionado de qualidade da IA: [docs/OPERACAO_MELHORIA_CONTINUA_IA.md](docs/OPERACAO_MELHORIA_CONTINUA_IA.md).
Índice completo de documentação: [docs/README.md](docs/README.md).

Atendimento multi-tenant via WhatsApp com módulo de leads e agendamento. O backend usa Fastify, PostgreSQL e BullMQ; o painel usa Next.js e Tailwind.

## Desenvolvimento local

Pré-requisitos: Node.js 22+, npm 12+, Docker e Docker Compose v2.

```bash
cp .env.example .env
npm ci
docker compose up -d --wait
npm run migrate -w @atendon/backend
npm run seed -w @atendon/backend
npm run dev
```

O painel abre em `http://localhost:3200`; a API em `http://localhost:3110`. Na primeira inicialização do volume, o Compose cria `atendon` e o banco isolado `atendon_test`. O seed cria o usuário definido por `PANEL_SEED_EMAIL`/`PANEL_SEED_PASSWORD` e registra `TENANT_API_KEY` para o mesmo tenant.

## Autenticação e API de agendamento

As rotas chamadas pela IA aceitam `X-API-Key: <TENANT_API_KEY>` ou `Authorization: Bearer <TENANT_API_KEY>`. O tenant é obtido da chave; quando `tenant` é informado na query, ele deve coincidir com ela.

Cada chave tem scopes por operação. A gestão fica restrita ao ROOT em acesso assistido ao workspace, em **Configurações → Chaves de API**. O segredo é exibido uma única vez. A rotação é feita em duas fases: a chave anterior continua ativa até a integração nova ser validada e sua revogação ser confirmada explicitamente.

- `POST /leads`
- `GET /categorias?tenant=<uuid>`
- `GET /parceiros?tenant=<uuid>`
- `POST /leads/:id/proposta-parceiro`
- `GET /unidades/:unidade_id/horarios?data=YYYY-MM-DD`
- `POST /agendamentos`
- `PATCH /agendamentos/:id/reagendar`
- `DELETE /agendamentos/:id`
- `PATCH /leads/:id/status`
- `POST /leads/:id/transferir`

Datas de agendamento são ISO 8601 com offset, por exemplo `2030-01-07T09:00:00-03:00`. Horários de funcionamento e disponibilidade usam o fuso IANA configurado no workspace e são persistidos como instantes UTC; transições de horário de verão inválidas são rejeitadas. Categoria, parceiro e unidade são cadastros por tenant; nenhum nome comercial é fixado no código.

O painel usa cookie de sessão após login e oferece lista/detalhe de leads, agenda diária/semanal com reagendamento por arrastar e soltar e CRUDs de configuração.

## Google Meet automático, sem Google Calendar

O AtendON cria a sala diretamente com `POST https://meet.googleapis.com/v2/spaces` no instante em que o agendamento é confirmado. Quando a automação está ativa, a confirmação só é persistida depois que o Google devolve um `meetingUri` válido. Esse mesmo URL:

- volta para a ferramenta da IA e é incluído deterministicamente na resposta ao contato;
- fica salvo em `scheduling_appointments` e aparece como **Entrar no Meet** na agenda;
- compõe um alerta com contato, data e horário, visível somente aos closers selecionados.

Para configurar:

1. Ative a Google Meet REST API no projeto Google Cloud.
2. Configure a tela de consentimento OAuth e crie um cliente OAuth do tipo **Aplicativo da Web**.
3. Cadastre como URI de redirecionamento o valor público de `GOOGLE_MEET_OAUTH_REDIRECT_URI`.
4. Preencha `GOOGLE_MEET_OAUTH_CLIENT_ID`, `GOOGLE_MEET_OAUTH_CLIENT_SECRET` e `GOOGLE_MEET_OAUTH_REDIRECT_URI` no servidor.
5. No painel, abra **Configurações → Google Meet**, clique em **Conectar com Google**, selecione os closers e ative a automação.

A integração usa OAuth 2.0 com consentimento individual e armazena somente o refresh token criptografado. Não exige acesso ao Google Admin, mas a conta conectada precisa ter acesso ao Google Meet. Ela não cria, lê nem sincroniza eventos no Google Calendar.

## Variáveis relevantes

Veja [.env.example](.env.example). Em produção, defina pelo menos:

- `NODE_ENV=production`, `HOST=127.0.0.1`, `DATABASE_URL` e `REDIS_URL`;
- `JWT_SECRET`, `DATA_ENCRYPTION_KEY`, `TENANT_API_KEY`, `PANEL_SEED_PASSWORD`, `PANEL_ORIGIN=https://atendon.alpdash.com.br` e `PANEL_PUBLIC_URL=https://atendon.alpdash.com.br`;
- `EVOLUTION_API_KEY`, `EVOLUTION_WEBHOOK_SECRET`, `EVOLUTION_DB_PASSWORD` e `EVOLUTION_PUBLIC_URL` quando a Evolution local for usada;
- `WHATSAPP_ENABLED=true` para habilitar o envio automático da IA e o worker do WhatsApp;
- `BACKEND_URL=http://127.0.0.1:3110` para o rewrite local do Next;
- `NEXT_PUBLIC_API_BASE_URL=/api` antes do build do painel;
- `TRANSFER_NOTIFICATION_WEBHOOK_URL` e `TRANSFER_NOTIFICATION_CHANNEL` somente se a rota de transferência de lead precisar integrar um sistema externo. Sem URL, a notificação permanece `pending`; o handoff de conversa para o telefone do atendente usa uma outbox própria.
- `GOOGLE_MEET_OAUTH_CLIENT_ID`, `GOOGLE_MEET_OAUTH_CLIENT_SECRET` e `GOOGLE_MEET_OAUTH_REDIRECT_URI` para o login Google. Cada workspace conecta sua própria conta no painel.

As chaves da OpenRouter são configuradas por workspace no painel e persistidas cifradas; não existe uma chave global no `.env`. Não versione `.env`, variantes `.env.*` nem arquivos JSON de credenciais em `chaves/`. Enquanto arquivos locais forem inevitáveis, restrinja o diretório a `0700` e os arquivos a `0600`; em produção, prefira um gerenciador de segredos. Gere valores aleatórios e use usuário PostgreSQL com privilégios limitados. `DATA_ENCRYPTION_KEY` deve ser diferente de `JWT_SECRET`; durante uma rotação, mantenha a chave anterior temporariamente em `DATA_ENCRYPTION_KEY_PREVIOUS` e execute `npm run rotate:data-key -w @atendon/backend`.

Os valores `POSTGRES_*` e `EVOLUTION_DB_PASSWORD` inicializam volumes novos, mas não rotacionam senhas de bancos já existentes. Em volumes persistentes, altere a senha dentro do PostgreSQL e atualize a URL da aplicação na mesma janela de manutenção. Use valor URL-safe em `EVOLUTION_DB_PASSWORD`, pois ele compõe `DATABASE_CONNECTION_URI`.

## Validação e build

```bash
npm run lint
npm run typecheck
npm run test:db:check -w @atendon/backend
npm run migrate:test -w @atendon/backend
npm test
npm run test:disposable -w @atendon/backend
npm run build
```

Os testes carregam `TEST_DATABASE_URL` somente do arquivo privado `.env.test`
(`0600`), criado a partir de `.env.test.example`; API, worker e migration de
produção nunca leem esse arquivo. O runner recusa usar o banco da aplicação.
`test:disposable` cria um banco com nome UUID, migra, testa e remove o banco no
`finally`, preservando o banco de testes persistente. Migrações usam ledger com
checksum, lock e uma transação por arquivo. Arquivos SQL aplicados são
imutáveis: qualquer correção deve ser uma nova migração.

O smoke test no navegador valida WCAG A/AA e overflow horizontal em 360, 768 e 1440 px. Sem credenciais ele cobre o login; com `PANEL_E2E_EMAIL` e `PANEL_E2E_PASSWORD` (ou as variáveis `PANEL_SEED_*`) também percorre as rotas autorizadas do painel:

```bash
npx playwright install chromium
npm run test:e2e
```

## Produção — atendon.alpdash.com.br

```bash
npm ci --include=dev
npm run migrate -w @atendon/backend
npm run seed -w @atendon/backend
NEXT_PUBLIC_API_BASE_URL=/api npm run build
```

Inicie os três processos pelo PM2:

```bash
pm2 startOrRestart ecosystem.config.js --only atendon-api,atendon-worker,atendon-panel --update-env
pm2 save
pm2 startup
pm2 status
```

Execute uma vez o comando privilegiado exibido por `pm2 startup`. Use `pm2 logs` separadamente para acompanhar os logs (o comando fica aberto até `Ctrl+C`).

O ecossistema PM2 supervisiona API, worker e painel (porta 3200), gravando stdout e stderr separadamente em `logs/`. O `./build.sh` executa lint, tipos e testes antes da janela; restringe commits automáticos ao diretório AtendON; sincroniza `package-lock.json`; gera `DEPLOY_VERSION` com versão e SHA completo; captura estado/logs PM2; preserva o artefato ativo; faz build; executa Playwright com backend/painel e bancos de teste gerenciados; cria e restaura um backup PostgreSQL em banco descartável; aplica migration com `NODE_ENV=production`; provisiona, registra o snapshot de flags e só então reinicia e valida PM2, `/ready`, painel e `/version`. Ele requer `curl`, `flock` (util-linux), PM2 e Docker Compose v2.

Artefatos operacionais privados ficam em `.deploy-state/` por padrão, ou nos diretórios absolutos definidos por `ATENDON_DEPLOY_STATE_DIR` e `ATENDON_BACKUP_DIR`. Se readiness/restart falhar, o artefato falho vai para quarentena e o anterior é restaurado. O rollback do schema é sempre forward-only: o script nunca roda down migration nem apaga dados. Consulte o [runbook de backup e restore verificável](docs/runbooks/database-backup-restore.md) também para proteger separadamente o banco e o volume de instâncias da Evolution.

Instale também a política de rotação para impedir crescimento indefinido dos arquivos do PM2. Se o checkout ou usuário de execução não forem `/var/www/apps/atendon` e `deploy`, ajuste ambos no arquivo antes de copiar.

```bash
sudo cp deploy/logrotate/atendon /etc/logrotate.d/atendon
sudo logrotate --debug /etc/logrotate.d/atendon
```

### Nginx e SSL

O arquivo [deploy/nginx/atendon.conf](deploy/nginx/atendon.conf) envia `/api/*` para a API na porta 3110 e o restante para o painel na porta 3200, preservando `Authorization` e `X-API-Key`.

```bash
sudo cp deploy/nginx/atendon.conf /etc/nginx/sites-available/atendon
sudo ln -sfn /etc/nginx/sites-available/atendon /etc/nginx/sites-enabled/atendon
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d atendon.alpdash.com.br
sudo certbot renew --dry-run
```

Após o Certbot, valide `https://atendon.alpdash.com.br`, `/api/health` e `/api/ready`. A readiness só responde 200 quando PostgreSQL, Redis, BullMQ e o heartbeat do worker estão saudáveis. O DNS do domínio deve apontar para o servidor antes da emissão.

O bloco acima é o bootstrap inicial. O Certbot acrescenta a configuração TLS ao arquivo instalado em `/etc/nginx`; depois da emissão, não recopie o template HTTP sobre ele. Em alterações futuras, preserve os blocos de certificado, aplique somente o diff de proxy/headers e sempre execute `nginx -t` antes do reload.

## Checklist de deploy

- Backup pré-migration criado e restauração validada.
- PostgreSQL/Redis conectados e migrações aplicadas.
- `/api/ready` responde 200 depois do restart da API e do worker.
- `/login` responde pelo painel depois do restart.
- API buildada e rodando como `atendon-api` no PM2.
- Painel buildado com `NEXT_PUBLIC_API_BASE_URL=/api` e rodando na porta 3200.
- `.env` de produção preenchido; nenhuma credencial no repositório.
- API key validada com tenant, scopes e expiração corretos; CORS em `PANEL_ORIGIN`.
- Nginx ativo para painel e `/api`, preservando headers.
- Certificado Let's Encrypt emitido e renovação testada.
- Se usado, webhook de transferência configurado e entrega monitorada.
- Se a automação de Meet estiver ativa, cliente OAuth configurado, conta Google conectada e grupo de closers selecionado no painel.
