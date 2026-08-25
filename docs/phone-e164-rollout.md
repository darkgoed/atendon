# Rollout da normalização E.164

Execute primeiro em staging. A auditoria e a migration nunca exibem telefones: somente workspace, tabela e IDs.

```bash
rtk npm run audit:phone-e164 -w @atendon/backend
rtk npm run backup:database -w @atendon/backend
rtk npm run migrate -w @atendon/backend
rtk npm run test:disposable -w @atendon/backend -- tests/fresh-migrations.integration.test.ts tests/appointment-assignees.integration.test.ts tests/notification-preferences.integration.test.ts
rtk npm test -w @atendon/backend -- tests/phone.test.ts
```

Interrompa o rollout se a auditoria apontar valores inválidos ou colisões. Corrija os registros pelos IDs, refaça a auditoria e gere um novo backup antes de migrar. Não mescle colisões automaticamente.

Para o incidente legado auditado em 2026-08-04, o script específico valida todos os vínculos e executa a consolidação somente com `--apply`. Os três telefones irrecuperáveis são preservados no log de auditoria e substituídos por identificadores internos sob `+999`, faixa reservada pela UIT. O backend rejeita essa faixa nas APIs e bloqueia texto, mídia e sticker antes de chamar o provedor.

```bash
rtk npm run remediate:phone-e164 -w @atendon/backend
rtk npm run remediate:phone-e164 -w @atendon/backend -- --apply
rtk npm run audit:phone-e164 -w @atendon/backend
```

Depois de validar staging, repita auditoria e backup imediatamente antes da janela de produção. Valide criação manual mascarada, webhook, JIDs `@s.whatsapp.net`, outboxes pendentes e busca por telefone. JIDs especiais, como `@lid`, devem permanecer inalterados.
