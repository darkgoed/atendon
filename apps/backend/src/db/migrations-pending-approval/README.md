# Migrations represadas — AGUARDANDO APROVAÇÃO EXPLÍCITA DO USUÁRIO

Arquivos aqui **não são executados** pelo runner de migrations.

## Por que este diretório existe

`apps/backend/src/db/migration-runner.ts:81` descobre migrations por varredura
automática do diretório:

```js
const filenames = (await readdir(directory)).filter((f) => f.endsWith(".sql")).sort();
```

Não há lista manual de registro. Portanto **qualquer `.sql` colocado em
`db/migrations/` roda sozinho no próximo deploy**. Um comentário de aviso no
topo do arquivo NÃO impede a execução — é apenas texto.

Para represar de verdade uma migration destrutiva é preciso tirá-la do
diretório varrido. É o que este diretório faz. A extensão `.staged` é uma
segunda barreira: mesmo que o arquivo seja movido por engano, o filtro
`.endsWith(".sql")` o ignora.

## Conteúdo atual

### `0126_remove_retired_ai_and_api_key_data.sql.staged`

`DROP TABLE` de 6 tabelas, referente aos itens do `comments.md` que pedem a
remoção 100% de "Melhoria da IA" e "Chaves de API":

- `ai_evaluation_case_results`
- `ai_evaluation_runs`
- `ai_improvement_proposals`
- `ai_regression_cases`
- `ai_attendance_evaluations`
- `tenant_api_keys`

O **código** dessas features foi removido nesta rodada. Só a remoção dos
**dados** está represada.

Risco: irreversível por rollback SQL. `tenant_api_keys` pode ter integrações
externas ativas dependendo dela — derrubar a tabela quebra qualquer cliente que
ainda autentique via `x-api-key`.

## Como aplicar, quando o usuário aprovar

1. Backup operacional do banco.
2. Inventário: contar linhas de cada tabela e checar dependências de FK.
3. Confirmar com o usuário que nenhuma integração externa usa API keys.
4. Mover o arquivo para `db/migrations/` removendo o sufixo `.staged`.
5. Rodar o runner na janela de manutenção.

Enquanto os passos 1–3 não forem feitos, o arquivo fica aqui.
