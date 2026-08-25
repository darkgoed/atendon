# Relatório técnico de hardening de segurança — AtendON

Data da revisão: 30 de julho de 2026  
Escopo: `/var/www/apps/atendon` e histórico Git alcançável do repositório pai  
Estado: correções implementadas localmente, sem commit, push, deploy, reescrita de histórico ou rotação de credenciais

## Resumo executivo

A revisão cobriu aplicação web e API, autenticação e sessões, autorização multitenant, banco de dados e migrações, uploads, webhooks, integrações externas, logs, dependências, Docker Compose, Nginx, configuração de testes e segredos no estado atual e no histórico Git.

Foram corrigidos problemas de maior impacto em integridade multitenant, administração de papéis, isolamento de segredos de testes, limitação distribuída de requisições, exposição de respostas de provedores em erros, limites de respostas externas, cabeçalhos defensivos, timeouts, exportação CSV e isolamento de containers. Não foi identificada credencial válida no histórico Git alcançável.

Ainda há riscos que dependem de infraestrutura ou governança: proteção DDoS na borda, firewall restritivo de origem, HSTS no terminador TLS, análise antimalware de uploads, MFA, revogação individual de sessões, retenção e descarte de dados, imutabilidade externa dos logs e processos organizacionais relacionados à LGPD. Este relatório não declara conformidade com a LGPD.

## Metodologia e limites

Foram usados:

- inspeção de arquitetura e relacionamentos com o grafo local do projeto;
- revisão manual de rotas, autenticação, sessão, RBAC, escopo de tenant, SQL, uploads, webhooks, logs, configuração e infraestrutura;
- testes unitários, de integração, banco descartável, migrações do zero e Playwright;
- auditoria de dependências de produção e desenvolvimento;
- Gitleaks 8.30.1 sobre o diretório atual e os 122 commits alcançáveis, sempre com redação integral dos valores;
- validação isolada da sintaxe do Nginx em container e renderização do Docker Compose.

Não foram realizados pentest destrutivo, carga agressiva, deploy, alteração de DNS/firewall/provedor, inspeção de backups externos, rotação de credenciais ou análise jurídica. O `nginx -t` do host não pôde ser concluído sem privilégios para certificados e logs; a mesma configuração passou no container oficial isolado.

## Vulnerabilidades corrigidas

| ID | Severidade | Situação anterior | Correção e evidência |
|---|---|---|---|
| SEC-01 | Alta | Tabelas de notificações de agenda podiam referenciar sessão ou agendamento de outro tenant apenas pelo UUID. | Migração `0092` adiciona chaves estrangeiras compostas com `tenant_id`, valida dados legados antes da alteração e cria índices de suporte. Migrações do zero e testes de tentativas cross-tenant passaram. |
| SEC-02 | Alta | Um administrador de workspace podia alterar/remover membros pares ou superiores em combinações de papéis não suficientemente restritas. | As rotas agora verificam hierarquia, impedem autoelevação, protegem o último administrador e restringem atribuições ao conjunto permitido. Testes de regressão passaram. |
| SEC-03 | Alta | O runner de testes podia reintroduzir o `.env` de runtime e expor chaves reais a código de teste. | Testes carregam somente `.env.test` privado (`0600`); variáveis privilegiadas de banco são removidas dos processos de runtime. O Playwright lê o arquivo em objeto isolado e mapeia apenas banco, Redis e senha seed necessários. |
| SEC-04 | Média | A limitação HTTP era apenas em memória, sem coordenação entre instâncias nem backoff progressivo. | Em produção, o Fastify usa contador Redis compartilhado, buckets pelo IP resolvido pelo proxy confiável, limites por classe de rota e backoff exponencial em autenticação. Dados não autenticados de JWT/API/webhook não participam da chave e não podem ser rotacionados para contornar o limite. Nginx adiciona uma segunda camada para login/webhook e limite de conexões. Há teste unitário e integração Redis. |
| SEC-05 | Média | Erros de OpenRouter/Evolution incluíam corpo, caminho ou detalhes do provedor que poderiam carregar dados pessoais ou conteúdo sensível para logs. | Erros mantêm somente provedor genérico e status. A política de redação passou a cobrir credenciais, e-mail, telefone/JID, IDs externos, instância e URLs de mídia. |
| SEC-06 | Média | Respostas da Evolution eram lidas sem limite explícito de tamanho. | Leitura por stream com limite de 48 MiB, validação de `Content-Length`, cancelamento ao exceder o teto e teste de regressão. |
| SEC-07 | Média | API/painel não tinham uma política de cabeçalhos homogênea; timeouts e proteção de conexões eram limitados. | API, Next.js e Nginx receberam CSP compatível, `nosniff`, bloqueio de framing, política de referência/permissões e `no-store` na API. Fastify/Nginx receberam timeouts e proteção contra prototype/constructor poisoning. SSE preserva timeout próprio. |
| SEC-08 | Média | Campos controlados por tenant exportados em CSV poderiam iniciar fórmulas em planilhas. | Valores iniciados por `=`, `+`, `-`, `@`, tab ou retorno são neutralizados antes do escaping CSV. |
| SEC-09 | Baixa | A verificação JWT não fixava explicitamente o algoritmo e tokens novos não possuíam identificador único. | Verificação restrita a `HS256` e novos tokens recebem `jti` aleatório, sem invalidar tokens existentes. A revogação por `session_version` foi preservada. |
| SEC-10 | Baixa | Containers não declaravam bloqueio de aquisição de novos privilégios. | Todos os serviços do Compose receberam `no-new-privileges:true`; `docker compose config --quiet` passou. |

## Controles confirmados e preservados

- cookies de sessão `HttpOnly`, `Secure` em produção e `SameSite=Lax`;
- CORS restrito à origem configurada do painel;
- validação de `Origin`/`Sec-Fetch-Site` em mutações, reduzindo CSRF;
- erro uniforme e hash bcrypt fictício no login, reduzindo enumeração e diferenças de tempo;
- `session_version` para revogação global após mudanças sensíveis;
- RBAC e API keys escopados por tenant, com chaves armazenadas por hash;
- transações com contexto de tenant, guardrails de banco e o piloto de RLS já cobertos por testes;
- upload com limites, MIME permitido, assinaturas de imagem nos fluxos que as validam e nomes sanitizados;
- autenticação de webhook por segredo com comparação resistente a timing;
- banco/API/Redis/Evolution publicados somente em loopback no Compose;
- papel de banco de runtime separado do papel de migração;
- segredos criptografados em repouso nos fluxos de OAuth/provedor que já utilizam a caixa criptográfica da aplicação;
- logs de URL sem query string e tokens de convite redigidos.

## Segredos e histórico Git

### Resultado

O scan do histórico percorreu 122 commits e retornou 10 candidatos `generic-api-key`. Todos foram classificados como falsos positivos ou placeholders:

- quatro ocorrências de senhas fictícias em teste no commit `88d77755cec34fc8062742e125d181993d05da96`;
- duas constantes fictícias de teste, um identificador de imagem e um placeholder de exemplo no commit `be95d7368c4884e194d31999c9eef696000cf160`;
- duas sequências em código/changelog de uma dependência externa no commit `cf4ba708ab5606b3b632aee848515b1b7fc188d3`.

Não foi encontrada credencial válida, chave privada real ou arquivo local de ambiente no histórico alcançável. Não há evidência que justifique reescrever o histórico.

O scan do diretório atual, excluindo apenas artefatos gerados/dependências definidos em `.gitleaks.toml`, retornou 21 candidatos:

- 9 em `.env`;
- 3 em `.env.migration`;
- 2 em `chaves/[credential-file]`;
- 6 constantes fictícias de testes;
- 1 identificador de imagem no Compose.

Os arquivos reais estão ignorados pelo Git. A chave privada e a credencial OAuth local foram verificadas apenas por metadados redigidos; nomes e valores não são reproduzidos neste relatório. Valores sensíveis de `.env` também foram comparados de forma programática contra os artefatos `.next`, sem correspondências.

### Rotação condicional

Nenhuma rotação foi executada. Como não houve segredo válido no histórico, a rotação é necessária somente se os arquivos locais tiverem sido copiados, enviados, incluídos em backup sem proteção, expostos em suporte/log ou acessados por pessoa/processo não autorizado.

Se houver suspeita, rotacionar nesta ordem:

1. chaves de provedores e integrações: OpenRouter, Evolution, SMTP, Google OAuth e conta de serviço;
2. segredo de webhook e API keys de tenant, revogando versões anteriores;
3. JWT, causando reautenticação planejada dos usuários;
4. credenciais dos papéis PostgreSQL, seguindo o runbook de rotação e atualizando runtime/migração separadamente;
5. chave de criptografia de dados por rotação em duas fases: configurar a chave anterior, recriptografar registros, verificar e só então retirar a chave antiga.

Não apagar nem substituir cegamente a chave de criptografia: isso pode tornar tokens e configurações existentes irrecuperáveis.

## Dependências e análise estática

- `npm audit --omit=dev`: 0 vulnerabilidades.
- `npm audit`: 9 ocorrências de severidade alta em `brace-expansion`, todas transitivas da cadeia de desenvolvimento ESLint/minimatch.
- O único reparo automático sugerido usa `--force` e instala uma versão incompatível de `@eslint/eslintrc`; ele não foi aplicado.
- Lint e TypeScript passaram sem warnings/erros.

O risco residual de `brace-expansion` fica restrito ao tooling local/CI: não é dependência de runtime, mas arquivos/globs fornecidos a essas ferramentas devem continuar controlados. Deve-se atualizar quando a cadeia oficial ESLint/Next resolver a dependência, sem forçar downgrade incompatível.

## Validação executada

| Validação | Resultado |
|---|---|
| `npm run lint` | passou |
| `npm run typecheck` | passou |
| `npm run build` | passou; backend e 28 rotas/páginas Next.js geradas |
| `npm test` | passou: 5 testes do changelog, 707 do backend e 96 do painel (808 no total) |
| migrações em banco limpo | 4 cenários passaram, incluindo a migração `0092` |
| Playwright | 3 cenários públicos passaram em mobile/tablet/desktop; 3 cenários autenticados foram ignorados por ausência de `PANEL_E2E_EMAIL`/`PANEL_E2E_PASSWORD` explícitos |
| `docker compose config --quiet` | passou |
| `nginx -t` em `nginx:1.29-alpine` isolado | passou |
| Gitleaks no estado atual | 21 candidatos, todos classificados; nenhum segredo versionado |
| Gitleaks no histórico | 122 commits, 10 falsos positivos/placeholders; nenhum segredo válido |
| `git diff --check` | passou |

Foi feita apenas validação limitada dos limitadores por testes/injeção Fastify e Redis. Não foi executado teste agressivo de carga contra a instalação.

## Riscos residuais e ações externas

### Prioridade alta

1. **DDoS e exposição de origem.** Rate limiting na aplicação e no Nginx não substitui mitigação de volumetria. Ativar CDN/WAF com proxy autoritativo, regras gerenciadas, bot management e proteção DDoS; no firewall da origem, aceitar HTTP(S) somente dos ranges publicados pelo CDN e manter SSH restrito à rede administrativa.
2. **Retenção e descarte.** Não há evidência de política automatizada e verificável para expirar mensagens, mídias, leads, auditoria, backups e artefatos exportados. Definir prazos por categoria/finalidade e implementar jobs idempotentes, exceções de legal hold e descarte de backups.
3. **Uploads sem antimalware/CDR.** MIME, assinatura e tamanho reduzem risco, mas documentos/imagens não passam por antivírus ou reconstrução de conteúdo. Adicionar quarentena assíncrona, scanner atualizado, bloqueio até aprovação e política de falha fechada para tipos de maior risco.

### Prioridade média

1. Habilitar HSTS, TLS 1.2/1.3 e redirecionamento HTTP no terminador TLS somente após confirmar que todos os subdomínios pretendidos suportam HTTPS.
2. Implementar MFA para root e administradores; idealmente WebAuthn/TOTP com recuperação auditada.
3. Adicionar inventário/revogação de sessões por dispositivo. A revogação global por `session_version` existe, mas não há blacklist individual server-side.
4. Enviar logs de auditoria para destino externo append-only/imutável, com alertas para mudanças de papéis, root access, exportações, rotação de chaves e falhas repetidas de autenticação.
5. Remover gradualmente `'unsafe-inline'` da CSP com nonces/hashes após validar a compatibilidade do Next.js. A política atual ainda reduz framing, objetos, navegação e origens, mas não é a forma mais estrita.
6. Restringir e monitorar egress para provedores conhecidos; aplicar allowlist de destino/IP nos webhooks configuráveis onde o produto permitir.
7. Configurar limites, alertas de custo e chaves de menor privilégio nos painéis de OpenRouter, Evolution, SMTP e Google; usar IP allowlisting quando suportado.
8. Revisar periodicamente acessos a arquivos locais ignorados e evitar incluí-los em imagens, tickets, artefatos CI ou backups sem criptografia.

## Lacunas técnicas relacionadas à LGPD

Os controles de tenant, papéis, auditoria, criptografia seletiva, redução de logs e exportação ajudam nos princípios de segurança, prevenção, necessidade e prestação de contas. Eles não são suficientes para afirmar conformidade.

Pontos que exigem validação técnica e organizacional:

- inventário de dados pessoais e sensíveis, finalidades, bases legais, operadores/suboperadores, localização e fluxos internacionais;
- avisos, consentimento quando aplicável e prova da finalidade para WhatsApp, IA e transcrição de áudio;
- fluxo autenticado e auditável para acesso, correção, portabilidade, anonimização, oposição e eliminação, inclusive propagação para provedores e backups;
- prazos de retenção e descarte por categoria, incluindo conversas, mídia, leads, agenda, logs, exports e backups;
- processo de incidente com detecção, preservação de evidências, avaliação de risco e eventual comunicação à ANPD/titulares;
- contratos e garantias com OpenRouter, Evolution, Google, SMTP, hospedagem, CDN/WAF e demais operadores;
- avaliação de impacto para tratamento em IA, mensageria e monitoramento, conforme o risco e a orientação jurídica;
- controle de acesso administrativo com MFA, revisões periódicas, segregação de função e trilha externa imutável;
- criptografia e ciclo de vida dos backups, inclusive testes de restauração e descarte das cópias expiradas;
- minimização de payloads enviados a provedores e mecanismo para atender exclusão também nesses serviços.

Esses itens devem ser revisados com encarregado e assessoria jurídica; o código fornece parte das salvaguardas técnicas, não uma conclusão legal.

## Arquivos e áreas alterados

- aplicação/API: `apps/backend/src/app.ts`, `auth/session.ts`, `logger.ts` e `security/http-rate-limit.ts`;
- autorização e rotas sensíveis: módulos `root`, `workspaces`, `scheduling` e `stickers`;
- integrações: clientes OpenRouter e Evolution;
- banco: migração `0092_scheduling_notification_tenant_integrity.sql`;
- painel: `next.config.ts` e bootstrap Playwright;
- infraestrutura: `deploy/nginx/atendon.conf` e `docker-compose.yml`;
- supply chain e segredos: `package-lock.json` e `.gitleaks.toml`;
- testes: suites de API, infraestrutura, logger, Evolution, migrações, banco e autorização.

`comments.md` já estava modificado e não faz parte do hardening. Alterações e diretórios sujos fora de `/var/www/apps/atendon` não foram tocados.

## Checklist antes de produção

1. Revisar o diff e aprovar a migração `0092` com backup/restauração testados.
2. Fornecer credenciais E2E exclusivas para executar também os três cenários autenticados.
3. Aplicar a configuração Nginx em ambiente de homologação e executar `nginx -t` com privilégios apropriados.
4. Validar CSP via `Content-Security-Policy-Report-Only` se houver scripts/recursos externos não presentes nos testes.
5. Configurar CDN/WAF, firewall, TLS/HSTS e alertas antes de expor a origem.
6. Planejar scanner de uploads, MFA, sessão por dispositivo e retenção automatizada.
7. Repetir `npm audit`, Gitleaks, build, testes e smoke tests no pipeline de release.
8. Rotacionar credenciais somente conforme a avaliação de exposição descrita acima.
