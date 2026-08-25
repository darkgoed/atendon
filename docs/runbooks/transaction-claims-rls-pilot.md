# Piloto RLS de claims transacionais

O piloto protege `agent_message_transaction_claims`. A policy é instalada pela
`0079`; a `0080` deixa a execução preparada, porém desativada, para que a
migration continue compatível com o artefato anterior durante o restart.

## Ativação

1. Migre e implante API/worker com `withTenantTransaction`.
2. Confirme `/ready`, os processos `atendon-api`/`atendon-worker` e uma gravação
   sintética de claim sem efeito externo.
3. Com a role de migration, ative:

```sql
BEGIN;
LOCK TABLE agent_message_transaction_claims IN ACCESS EXCLUSIVE MODE;
ALTER TABLE agent_message_transaction_claims ENABLE ROW LEVEL SECURITY;
COMMIT;
```

4. Verifique em `pg_class` que `relrowsecurity` e `relforcerowsecurity` são
   verdadeiros.
5. Com a role runtime, valide que uma transação com `SET LOCAL app.tenant_id`
   enxerga apenas o tenant definido e que a mesma consulta sem contexto retorna
   zero linhas.

`SET LOCAL` deve existir apenas dentro de `BEGIN`/`COMMIT`; nunca use `SET`
persistente em conexão de pool.

## Rollback operacional

Se API/worker registrar erro de policy ou faltar contexto tenant:

```sql
ALTER TABLE agent_message_transaction_claims DISABLE ROW LEVEL SECURITY;
```

Desativar a policy não altera nem remove claims. Preserve logs sanitizados,
reimplante/corrija o helper e repita a ativação. Não edite as migrations já
aplicadas e não conceda `BYPASSRLS` à role runtime.
