# Efí Pix Automático — o que falta validar com a conta habilitada

Estado: integração implementada contra a documentação pública da Efí
(https://dev.efipay.com.br/docs/api-pix/pix-automatico, `/gestao-de-pix`,
`/status`, `/webhooks`). Nenhuma chamada real foi feita; toda a suíte usa uma
API Efí falsa. A conta Efí Empresas ainda não está habilitada.

## 1. Estorno / devolução (NÃO ligado a job nem webhook)

Código pronto e idempotente: `apps/backend/src/billing/efipay-refunds.ts`
(`applyVerifiedEfiRefund`), testes em
`tests/billing-efipay-monthly-batch.integration.test.ts` (bloco "estorno Efí").

Regra implementada (sem heurística):
- Única prova aceita: `GET /v2/pix/:e2eId` autenticado do Pix que pagou a
  cobrança, com `txid` e `valor` iguais aos da cobrança, e `devolucoes[]` cuja
  soma em `status = DEVOLVIDO` cobre o valor integral (R$157,00).
- `EM_PROCESSAMENTO`, `NAO_REALIZADO`, lista vazia → nada muda.
- Devolução parcial → `partial_review` (nada é descontado; decisão humana).
- Cobrança `CANCELADA`/`NEGADA`/`EXPIRADA` NUNCA é tratada como estorno.
- Estorno integral: fatura `refunded`, payment `refunded`, compra `REVERSED`,
  revoga só o saldo restante do pacote (consumo já feito permanece). Replay e
  execução concorrente não revogam duas vezes.

O que falta validar antes de ligar (sandbox `pix-h.api.efipay.com.br`):
1. Como obter o `endToEndId` do Pix que LIQUIDOU a cobrança de Pix Automático.
   A doc só mostra `tentativas[].endToEndId` em exemplos de tentativa
   AGENDADA/CANCELADA/EXPIRADA — confirmar se `GET /v2/cobr/:txid` com
   `status=CONCLUIDA` traz a tentativa liquidada com `endToEndId` (e o nome
   exato do status da tentativa).
2. Se `GET /v2/pix/:e2eId` funciona para Pix de Pix Automático (escopo
   `pix.read` habilitado na aplicação) e se o campo `txid` vem preenchido com o
   txid da cobr.
3. Payload do webhook `DEVOLUCAO_RECEBIDA`/devolução para cobranças de Pix
   Automático (a doc de webhooks mostra `pix[].devolucoes[]` para Pix comum,
   incluindo `natureza: MED_FRAUDE`). Webhook só deve DISPARAR a consulta
   autenticada acima — nunca conceder/revogar pelo corpo do webhook.
4. Devolução iniciada pelo pagador via MED: confirmar que aparece como
   `DEVOLVIDO` no mesmo `devolucoes[]`.

Para ligar: gravar o e2eId confirmado na cobrança (nova coluna), chamar
`applyVerifiedEfiRefund` no lote mensal/webhook para cobranças `APPROVED`, e
tratar `partial_review` como alerta operacional.

## 2. Cancelamento da autorização (mandato)

A API documenta `PATCH /v2/rec/:idRec` ("Revisar recorrência"), mas o exemplo
só altera `loc`, `vinculo.devedor`, `calendario.dataInicial` e `ativacao`; não há
operação documentada de cancelamento/revogação da recorrência pelo recebedor.
Comportamento atual (mantido):
- "Parar cobranças futuras" cancela (`PATCH /v2/cobr/:txid` → `CANCELADA`) as
  cobranças futuras já criadas, marca o mandato local `CANCELLED` e encerra as
  faturas desses ciclos (`cancelled`).
- Depois do stop, o AtendON não cria cobrança nova: o PUT da cobrança só ocorre
  sob lock da linha do mandato com status `APPROVED`, e o stop toma o mesmo
  lock; cobrança criada durante o stop faz o stop falhar e ser repetido.
- Cobrança com vencimento HOJE não pode ser cancelada (Efí devolve 400 na data
  da 1ª tentativa de liquidação); se for paga, os créditos são concedidos.
- A autorização continua válida no banco do pagador até ele cancelá-la no app
  do banco. Isso está dito na UI (Uso → Pix Automático) e na resposta de
  `DELETE /billing/ai-credit-packs/pix-automatic` (`remoteRevocation`).
- Fatura de ciclo não pago (cancelado, negado ou expirado) fecha como
  `cancelled`/`failed`; fatura de pacote nunca entra no dunning (o débito é
  agendado pelo banco do pagador, não por retentativa de Pix avulso).

Validar no sandbox: se `PATCH /v2/rec/:idRec` aceita `{"status":"CANCELADA"}`.
Só se a Efí documentar/confirmar isso, adicionar a chamada ao stop.

## 3. Outros pontos a confirmar com a conta habilitada

- Webhook de recorrência/cobrança de Pix Automático (configuração e payload).
  Hoje a conciliação é só por polling autenticado no worker (lote mensal).
- `vinculo.contrato`/`vinculo.objeto` no `POST /v2/rec` (enviado conforme o
  exemplo oficial).
- Status `NEGADA`/`REJEITADA` de cobrança e `EXPIRADA` de recorrência reais.
- Homologação: provider `efipay` segue `enabled=false` até o cadastro das
  credenciais (certificado .p12) pelo painel root.
