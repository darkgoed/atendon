# Correção das Vulnerabilidades do AtendON — Plano de Implementação

> **Para o Hermes:** usar desenvolvimento orientado a testes e revisão de segurança por tarefa. Não fazer commit, push ou deploy sem solicitação explícita do usuário.

**Objetivo:** eliminar o bypass de RBAC nas rotas legadas de leads/agendamentos, revogar sessões no logout, exigir tags AES-GCM completas e endurecer destinos de Web Push/webhooks sem quebrar o isolamento multi-tenant.

**Arquitetura:** reutilizar os controles já maduros das rotas `/scheduling/*`: `requirePermission`, `resolveCaseScope`, `canAccessLead` e `canAccessAppointment`. Para logout, usar o `session_version` existente como correção imediata e segura, aceitando que o logout revogará as sessões do usuário em todos os dispositivos. Centralizar validação de destinos HTTP em um módulo de segurança e, para Web Push, validar também o endereço resolvido na conexão para evitar DNS rebinding.

**Stack:** TypeScript, Fastify 5, PostgreSQL, Vitest, `jose`, `node:crypto`, `node:https`, `node:dns`, `web-push`.

---

## Escopo e prioridades

### P0 — bloquear exploração autenticada

1. Corrigir autorização das rotas legadas em `apps/backend/src/modules/scheduling/routes.ts:113-162`.
2. Invalidar o token reutilizado depois de `POST /auth/logout` em `apps/backend/src/app.ts:687`.

### P1 — corrigir primitiva criptográfica

3. Exigir IV e tag AES-GCM nos tamanhos esperados em `apps/backend/src/modules/ai-router/secret-box.ts`.

### P2 — endurecer saída de rede

4. Bloquear destinos locais/privados em Web Push e em webhooks configuráveis.
5. Restringir endpoints Google OAuth/Meet em produção.

Não incluir nesta rodada: redesign do login, MFA, troca de biblioteca JWT, refatoração geral das rotas ou mudanças de produto não relacionadas.

---

## Tarefa 1: criar testes de regressão para o bypass de RBAC

**Objetivo:** reproduzir o achado com dados descartáveis e provar ausência de efeitos após a correção.

**Arquivos:**
- Criar: `apps/backend/tests/scheduling-legacy-authorization.integration.test.ts`
- Referência: `apps/backend/tests/panel-api.integration.test.ts:24-123`
- Referência: `apps/backend/src/auth/rbac.ts:3-94`

**Passos:**

1. Criar tenant descartável, executar `ensureWorkspaceDefaultRoles` e cadastrar:
   - owner com todas as permissões;
   - usuário em função personalizada sem permissões;
   - operador com permissões normais;
   - segundo operador para validar escopo `mine`;
   - segundo tenant para validar isolamento.
2. Criar diretamente no banco um lead e um agendamento pertencentes ao primeiro operador.
3. Escrever uma tabela de testes negativos para as rotas legadas:

   | Método e rota | Permissão exigida | Controle de objeto |
   |---|---|---|
   | `POST /leads` | `leads.create` | atribuição compatível com o escopo |
   | `GET /categorias` | `categories.read` | tenant da sessão |
   | `GET /parceiros` | `partners.read` | tenant da sessão |
   | `POST /leads/:id/proposta-parceiro` | `leads.send_partner_proposal` | `canAccessLead` |
   | `GET /unidades/:unidade_id/horarios` | `availability.read` | tenant da sessão |
   | `POST /agendamentos` | `appointments.create` | lead acessível e atribuição válida |
   | `PATCH /agendamentos/:id/reagendar` | `appointments.reschedule` | `canAccessAppointment` |
   | `DELETE /agendamentos/:id` | `appointments.cancel` | `canAccessAppointment` |
   | `PATCH /leads/:id/status` | `leads.update_status` | `canAccessLead` |
   | `POST /leads/:id/transferir` | `leads.transfer` | `canAccessLead` |

4. Para usuário sem permissão, esperar `403` e reler o registro para confirmar que não mudou.
5. Para usuário com permissão mas fora do escopo do objeto, esperar `404`, evitando enumeração.
6. Para IDs do segundo tenant, esperar `404` e confirmar estado inalterado.
7. Executar:

   `npm run test -w @atendon/backend -- tests/scheduling-legacy-authorization.integration.test.ts`

   Resultado esperado antes da correção: pelo menos as mutações legadas retornam sucesso indevido.

---

## Tarefa 2: aplicar RBAC e escopo de objeto às rotas legadas

**Objetivo:** fazer as rotas antigas obedecerem aos mesmos controles das rotas `/scheduling/*`.

**Arquivos:**
- Modificar: `apps/backend/src/modules/scheduling/routes.ts:113-162`
- Testar: `apps/backend/tests/scheduling-legacy-authorization.integration.test.ts`

**Passos:**

1. Substituir `requireWorkspace(request)` pelas permissões da matriz da Tarefa 1.
2. Nas operações sobre lead, obter `{ session, scope }` por `panelCaseScope` e chamar `canAccessLead` antes do serviço.
3. Nas operações sobre agendamento, obter `{ session, scope }` e chamar `canAccessAppointment` antes de reagendar/cancelar.
4. Em criação de agendamento, validar que o lead informado pertence ao tenant e está visível ao chamador antes de chamar `createAppointment`.
5. Em criação/upsert de lead, copiar as proteções já usadas em `POST /scheduling/leads` (`routes.ts:305-330`), incluindo o caso em que o telefone já pertence a lead fora do escopo.
6. Manter a capability como barreira adicional; não remover entradas de `API_CAPABILITY_GATES` em `apps/backend/src/capabilities/gate.ts:11-22`.
7. Retornar `403` para ausência de permissão e `404` para objeto existente mas invisível.
8. Executar o teste da Tarefa 1; esperado: todos os casos negativos passam e o banco permanece inalterado.
9. Executar testes relacionados:

   `npm run test -w @atendon/backend -- tests/panel-api.integration.test.ts tests/capability-gates.test.ts tests/saas-foundation.integration.test.ts`

**Critério de aceite:** nenhuma rota legada mutável pode ser usada apenas com membership; permissionamento e case scope são obrigatórios.

---

## Tarefa 3: revogar sessão no logout

**Objetivo:** impedir replay do cookie após logout.

**Decisão:** usar `users.session_version` nesta rodada. É uma correção pequena, já compatível com `requireIdentity`, sem migration. Tradeoff aceito: logout encerra todas as sessões do usuário.

**Arquivos:**
- Modificar: `apps/backend/src/app.ts:687`
- Testar: `apps/backend/tests/panel-api.integration.test.ts` ou criar `apps/backend/tests/logout-revocation.integration.test.ts`

**Passos:**

1. Escrever teste que:
   - cria usuário e cookie válidos;
   - confirma `GET /me` = `200`;
   - chama `POST /auth/logout`;
   - reutiliza o cookie capturado;
   - espera `GET /me` = `401`.
2. Escrever teste com dois cookies do mesmo usuário e documentar que ambos são revogados.
3. Preservar logout idempotente quando não há cookie ou quando o cookie já é inválido: limpar o cookie e retornar `200`, sem mascarar falhas reais de banco.
4. Quando houver sessão válida, incrementar atomicamente:

   `UPDATE users SET session_version=session_version+1,updated_at=now() WHERE id=$1`

5. Limpar `atendon_session` com o mesmo `path` usado na criação.
6. Aplicar `HTTP_RATE_LIMITS.sensitiveWrite` à rota.
7. Executar:

   `npm run test -w @atendon/backend -- tests/logout-revocation.integration.test.ts tests/realtime-routes.test.ts`

8. Confirmar que uma conexão SSE é encerrada no heartbeat seguinte, pois `requireSession` detectará a versão revogada.

**Critério de aceite:** nenhum JWT emitido antes do logout é aceito depois dele.

**Evolução posterior opcional:** tabela de sessões por `jti` para logout por dispositivo. Não incluir agora sem requisito explícito.

---

## Tarefa 4: exigir tag AES-GCM de 128 bits

**Objetivo:** rejeitar ciphertext com IV/tag truncados antes de chamar o decifrador.

**Arquivos:**
- Modificar: `apps/backend/src/modules/ai-router/secret-box.ts:27-37`
- Modificar: `apps/backend/tests/secret-box.test.ts`

**Passos:**

1. Adicionar teste que reduz a tag gerada de 16 para 4 bytes e espera `Invalid encrypted secret`.
2. Adicionar testes para IV diferente de 12 bytes, tag vazia e base64url não canônico.
3. Definir constantes:
   - IV AES-GCM: 12 bytes;
   - tag: 16 bytes.
4. Em `encryptSecret`, passar `{ authTagLength: 16 }` a `createCipheriv`.
5. Em `decryptWithKey`, decodificar IV/tag/ciphertext uma vez, validar comprimentos e passar `{ authTagLength: 16 }` a `createDecipheriv`.
6. Manter compatibilidade com ciphertexts `v1` e `v2` existentes, que já são gravados com tag de 16 bytes.
7. Executar:

   `npm run test -w @atendon/backend -- tests/secret-box.test.ts tests/data-key-rotation.test.ts`

**Critério de aceite:** tags truncadas nunca autenticam; dados existentes continuam legíveis e rotacionáveis.

---

## Tarefa 5: criar política reutilizável para URLs de saída

**Objetivo:** bloquear loopback, link-local, redes privadas, endereços reservados e esquemas inseguros.

**Arquivos:**
- Criar: `apps/backend/src/security/outbound-url.ts`
- Criar: `apps/backend/tests/outbound-url.test.ts`

**Interface proposta:**

- `parsePublicHttpsUrl(raw: string): URL`
- `resolvePublicAddresses(url: URL): Promise<LookupAddress[]>`
- `createPublicHttpsAgent(): https.Agent`

**Passos:**

1. Escrever testes de tabela para IPv4 e IPv6:
   - rejeitar `localhost`, `127.0.0.0/8`, `0.0.0.0/8`, RFC1918, `169.254.0.0/16`, multicast/reservados, `::1`, `fc00::/7`, `fe80::/10` e IPv4 mapeado em IPv6;
   - rejeitar usuário/senha embutidos e protocolos diferentes de HTTPS;
   - aceitar hostname público sintático.
2. Mockar `dns.lookup({ all: true })` e rejeitar o destino se qualquer endereço retornado for não público.
3. Criar `https.Agent` com callback `lookup` que repete a validação no momento da conexão. Isso fecha a janela de DNS rebinding entre cadastro e envio.
4. Definir timeout e não seguir redirects automaticamente.
5. Não criar allowlist fixa de fornecedores Web Push: isso quebraria navegadores/provedores legítimos. Usar política de rede pública e egress control.
6. Executar:

   `npm run test -w @atendon/backend -- tests/outbound-url.test.ts`

---

## Tarefa 6: aplicar a política ao Web Push

**Objetivo:** impedir que assinaturas sejam usadas para alcançar serviços internos.

**Arquivos:**
- Modificar: `apps/backend/src/modules/web-push/routes.ts:9-19,66-83`
- Modificar: `apps/backend/src/modules/web-push/processor.ts:33-43,63-77`
- Modificar: `apps/backend/tests/web-push.test.ts`
- Modificar: `apps/backend/tests/web-push.integration.test.ts`

**Passos:**

1. Validar formato HTTPS e ausência de destino obviamente privado no cadastro.
2. Antes de persistir, resolver DNS e rejeitar destino não público com `400` e código estável, sem retornar IPs internos.
3. Injetar `createPublicHttpsAgent()` em `VapidWebPushSender` e passá-lo em `RequestOptions.agent` — a tipagem instalada de `web-push` suporta `https.Agent`.
4. Definir `timeout` explícito no envio.
5. Testar que:
   - endpoint público mockado é aceito;
   - loopback/IP privado é rejeitado;
   - hostname que muda de público para privado é bloqueado no envio;
   - falha de resolução não persiste assinatura;
   - fluxos atuais de expiração 404/410 continuam passando.
6. Executar:

   `npm run test -w @atendon/backend -- tests/web-push.test.ts tests/web-push.integration.test.ts tests/outbound-url.test.ts`

**Critério de aceite:** nenhum endereço local/privado chega a `webPush.sendNotification`.

---

## Tarefa 7: endurecer webhooks e endpoints OAuth configuráveis

**Objetivo:** evitar SSRF/exfiltração por configuração incorreta ou comprometida.

**Arquivos:**
- Modificar: `apps/backend/src/config.ts`
- Modificar: `apps/backend/src/modules/scheduling/service.ts:2612-2617`
- Modificar: `apps/backend/src/modules/scheduling/google-meet.ts`
- Testar: testes de configuração e Google Meet existentes em `apps/backend/tests/`

**Passos:**

1. Exigir HTTPS para `TRANSFER_NOTIFICATION_WEBHOOK_URL` em produção.
2. Validar o destino com `parsePublicHttpsUrl` no startup e novamente antes do `fetch`.
3. Adicionar assinatura HMAC do corpo do webhook, com segredo dedicado de ambiente, timestamp e proteção contra replay no consumidor. Se o consumidor ainda não suportar assinatura, dividir esta etapa em rollout compatível antes de torná-la obrigatória.
4. Fixar em produção os hosts Google esperados para autorização, token e API Meet. Permitir endpoints alternativos apenas em `NODE_ENV=test/development`.
5. Aplicar timeout e política de agente público às chamadas externas compatíveis com `fetch`; se o agente não puder ser injetado com a API atual, usar `undici.Agent` com lookup controlado ou egress no container, após spike isolado.
6. Adicionar testes de configuração para HTTP, loopback, RFC1918 e host OAuth inesperado.
7. Executar testes direcionados:

   `npm run test -w @atendon/backend -- tests/google-meet.test.ts tests/google-meet-scheduling.integration.test.ts tests/meet.test.ts`

**Critério de aceite:** produção falha no startup com endpoint inseguro; dados de lead nunca são enviados para destino não público ou não autorizado.

---

## Tarefa 8: validação final e revisão

**Objetivo:** provar que as correções não quebram autenticação, agenda, integrações ou isolamento.

**Passos:**

1. Executar typecheck:

   `npm run typecheck`

   Esperado: sucesso.

2. Executar lint:

   `npm run lint`

   Atualmente há erros não relacionados; não mascará-los. Separar claramente erros anteriores de erros introduzidos nesta correção e exigir zero erro novo.

3. Executar suíte backend:

   `npm run test -w @atendon/backend`

   Esperado: todos os testes concluídos, sem timeout e sem testes ignorados relacionados ao escopo.

4. Executar build:

   `npm run build`

   Esperado: backend e painel compilam.

5. Reexecutar Semgrep nas áreas alteradas:

   `semgrep scan --config p/typescript --config p/nodejs --config p/owasp-top-ten apps/backend/src`

   Esperado: alerta `gcm-no-tag-length` removido; revisar manualmente qualquer novo alerta.

6. Revisar manualmente a matriz de autorização:
   - anônimo;
   - membro sem permissões;
   - operador com objeto próprio;
   - operador com objeto de outro atendente;
   - supervisor/admin;
   - root;
   - outro tenant.
7. Confirmar via `git diff -- apps/atendon` que somente arquivos necessários foram alterados e que as mudanças já existentes em `meeting-confirmation.ts`, `meeting-confirmation.test.ts` e `preview-confirmations.ts` não foram sobrescritas nem incluídas acidentalmente.
8. Se o usuário solicitar commit, usar somente o escopo `apps/atendon/**`, em commits separados sugeridos:
   - `fix(atendon): aplica RBAC às rotas legadas de agenda`
   - `fix(atendon): revoga sessões no logout`
   - `fix(atendon): exige tag completa no secret box`
   - `fix(atendon): restringe destinos de saída`

---

## Riscos e decisões

- **Logout global:** incrementar `session_version` encerra todos os dispositivos. É seguro e simples; sessões por `jti` ficam como evolução separada.
- **Compatibilidade das rotas legadas:** clientes que dependiam apenas de membership receberão `403`. Antes do deploy, mapear consumidores internos e conceder somente as permissões necessárias.
- **Web Push:** allowlist fixa de Google/Mozilla/Apple não é recomendada; pode quebrar provedores legítimos. A proteção deve ocorrer por classificação de IP, lookup no socket e egress.
- **DNS rebinding:** validar só no cadastro é insuficiente; a conexão precisa usar lookup controlado.
- **Webhook assinado:** requer rollout coordenado com o consumidor para evitar interrupção.
- **Mudanças concorrentes:** o worktree contém alterações AtendON não relacionadas; aplicar patches mínimos e revisar diff por arquivo.

## Definição de pronto

- Usuário sem permissão recebe `403` em todas as rotas legadas.
- Usuário com permissão mas fora do case scope recebe `404` e nenhum registro muda.
- Replay do cookie após logout recebe `401`.
- Tag AES-GCM de 4 bytes é rejeitada; ciphertexts atuais continuam válidos.
- Destinos privados/loopback são bloqueados no cadastro e na conexão de Web Push.
- Configurações externas inseguras falham antes de transmitir PII.
- Typecheck e build passam; suíte de segurança direcionada passa; nenhum erro novo de lint.
- Nenhuma mudança fora de `apps/atendon/**` e nenhum artefato gerado entra no release.
