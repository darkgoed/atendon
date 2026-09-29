# Runbook: rollback e correção de releases

> Lição dos incidentes de 2026-09-29: (1) um RELEASE auto-classificado saltou a
> numeração da casa 2.x.x para a 3.x.x; (2) o webhook de auto-deploy nunca
> funcionou (segredo divergente) e os deploys "após push" eram manuais; (3) a
> `DEPLOY_VERSION` congelada fazia toda release nascer com a tag de imagem de
> 27/ago, dificultando saber o que rodava em produção. Este runbook cobre os
> procedimentos para não repetir nenhum dos três.

## 0. Modelo mental

- Produção é **compose-build por fonte**: a cada deploy o Coolify clona o
  `main`, reconstrói as imagens e etiqueta com a env `DEPLOY_VERSION`. A tag é
  um **rótulo da release**, não um artefato reutilizável — apontar a tag velha
  **não** traz o código velho de volta.
- Portanto: **rollback real = re-deploy do código antigo** (graft de revert),
  e a numeração da release segue sempre para frente (nunca "des-publicar").
- Release = linha na tabela `releases` (fonte da verdade da versão exibida no
  painel) + commit de graft no `darkgoed/atendon` `main` + imagens
  `atendon/{panel,api,worker}:vX.Y.Z`.

## 1. Rollback de deploy (release ruim em produção)

Caminho oficial (fonte, ~5–8 min, auditável):

1. No monorepo, reverta o(s) commit(s) do problema (`git revert`, escopo
   `apps/atendon/**`).
2. `npm run release:prepare` (nova build, PATCH) e commit do bump
   (`chore: release vX.Y.Z`).
3. Graft do delta para o repositório standalone e PR com squash merge
   (convenção do marcador: `...(graft de <sha-mono>)`).
4. Antes do merge: `npm run release:coolify-tag` (grava `DEPLOY_VERSION=vX.Y.Z`
   no Coolify) — o push no merge dispara o deploy pelo webhook.
5. Conferir no audit log (`webhook.deployment.queued`) e nas imagens
   (`docker images | grep atendon`).

**Migration**: reverter código NÃO reverte schema. O projeto trata migrations
como aditivas/compatíveis; se a release ruim incluiu migration destrutiva, o
rollback de código não basta — avaliar restore pontual do banco (backup
anterior) com o time, nunca um `DOWN` manual ad-hoc.

Emergência (conter incidente ativo antes do revert ficar pronto, no host):

```bash
docker tag atendon/panel:vX.Y.(Z-1) atendon/panel:rollback
# idem api/worker; editar ATENDON_IMAGE_PREFIX/DEPLOY_VERSION… alternativa
# mais simples e equivalente: setar DEPLOY_VERSION para a tag anterior e
# reexecutar o deploy — o compose reconstrói da fonte atual, então só use
# este caminho se o código atual JÁ for o revert.
```

Prefira sempre o caminho oficial; o atalho por imagem é sobrescrito no deploy
seguinte.

## 2. Deploy não disparou no push

1. `docker exec coolify sh -c "grep webhook /var/www/html/storage/logs/audit-*.log | tail"`.
2. `webhook.github.signature_failed` → o segredo do hook divergiu do
   `manual_webhook_secret_github` da aplicação (rotacionou no Coolify?).
   Sincronizar novamente (extrair via tinker do model, atualizar o hook via
   API do GitHub; nunca colar o segredo em chat/ticket).
3. "No applications found with deploy key set, branch is X" → o push foi para
   branch diferente de `main`; o app só escuta `main`.
4. `is_auto_deploy_enabled` (application_settings) precisa estar `true`.
5. Último recurso operacional: enfileirar manualmente pelo painel do Coolify
   (mesmo efeito do webhook).

## 3. Correção de numeração de versão (a "casa" errada)

Cenário: a versão saltou de nível sem intenção (ex.: 2.x.x → 3.x.x).

1. **Nunca apagar linhas de `releases`** (histórico, changelog público e worker
   de IA referenciam por build_number).
2. Renumerar as builds afetadas preservando a sequência patch a patch:
   ```sql
   UPDATE releases SET version = CASE build_number
     WHEN 136 THEN '2.2.5' WHEN 137 THEN '2.2.6'
     WHEN 138 THEN '2.2.7' WHEN 139 THEN '2.2.8' END
   WHERE build_number IN (136,137,138,139);
   ```
   (o painel e `/changelog` leem daqui — a exibição corrige na hora).
3. Alinhar a tag das imagens: `npm run release:coolify-tag`.
4. O `package.json` converge na próxima release (`release:prepare` calcula a
   versão pela última linha da tabela, não pelo package.json).
5. Prevenção: o salto de major hoje **falha** o `release:prepare` sem
   `RELEASE_CLASSIFICATION_OVERRIDE=RELEASE` explícito (guard em
   `release-record.mjs`); PATCH/DROP seguem automáticos.

## 4. Estado do cliente não é rollback

"Sumiu/quebrou só para mim" frequentemente é estado local do navegador
(ex.: `atendon.dashboard.*` no localStorage) e não regressão de release.
Antes de rodar rollback: reproduzir com cache/limpo, conferir a versão exibida
no painel (`/panel/version` → tabela `releases`) e a tag das imagens rodando
(`docker ps`).

## 5. Checklist pós-release (2 minutos)

- [ ] `GET /panel/version` mostra a versão esperada.
- [ ] `docker ps` mostra imagens `:vX.Y.Z` da release (tag == versão).
- [ ] Containers healthy; deploy `finished` na fila do Coolify.
- [ ] Audit log tem `webhook.deployment.queued` para o push (ou o deploy foi
      manual de propósito).
- [ ] `/changelog` (e `/root/versions`) mostram a release publicada.
