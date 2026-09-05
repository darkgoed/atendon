# Objetivo

Adicionar ao AtendON uma arquitetura profissional de cobrança por uso excedente de IA, integrada aos planos SaaS existentes.

O sistema deverá suportar:

* franquia mensal de IA incluída em cada plano;
* bloqueio automático ao atingir a franquia;
* crédito de uso opcional para continuar utilizando IA;
* limite adicional configurável em reais;
* opção de crédito ilimitado;
* contabilização real de consumo;
* cobrança do excedente junto da próxima renovação;
* histórico detalhado de uso;
* mensal, trimestral e anual;
* descontos por periodicidade;
* alertas de consumo;
* auditoria;
* integração futura com os gateways já previstos.

Antes de implementar, analisar a arquitetura atual de planos, billing, IA, empresas, subscriptions e usage criada anteriormente.

Não duplicar estruturas existentes.

---

# 1. Conceito principal

Cada plano possui uma franquia mensal de uso de IA.

Exemplo inicial:

```text
BÁSICO
IA habilitada: não
Franquia: 0

MÉDIO
IA habilitada: sim
Franquia: 10.000 interações/mês

PRO
IA habilitada: sim
Franquia: 40.000 interações/mês
```

Esses valores devem ser totalmente configuráveis pelo ROOT.

Não deixar nenhum limite hardcoded.

---

# 2. Franquia mensal independente da periodicidade

A franquia de IA deve continuar sendo mensal mesmo quando o cliente contratar:

* mensal;
* trimestral;
* anual.

Exemplo:

Plano Médio anual:

```text
Pagamento:
12 meses antecipados

Franquia:
10.000 interações por mês
```

NÃO entregar 120.000 interações de uma vez.

Todo mês deve iniciar um novo UsagePeriod.

---

# 3. Crédito de uso

Criar uma funcionalidade denominada:

```text
Crédito de uso
```

Descrição para usuário:

"Continue utilizando a IA caso atinja a franquia incluída no seu plano."

Configurações:

```text
enabled: true / false

limitType:
FIXED
UNLIMITED

monthlySpendingLimitBrl
```

Exemplo:

```text
Crédito de uso: ATIVO

Limite:
R$ 20,00/mês
```

---

# 4. Comportamento sem crédito

Exemplo:

Plano Médio:

```text
10.000 / 10.000
```

Crédito de uso:

```text
DESATIVADO
```

Resultado:

* IA deixa de executar novas gerações;
* restante do AtendON continua funcionando normalmente;
* não bloquear Conversas, Pipeline, Agenda etc.;
* apresentar mensagem clara ao usuário.

Exemplo:

```text
Você atingiu a franquia mensal de IA do seu plano.

Uso atual:
10.000 / 10.000

Ative o Crédito de Uso ou aguarde a renovação da franquia.
```

---

# 5. Comportamento com crédito

Exemplo:

```text
Franquia:
10.000 / 10.000

Crédito adicional:
ATIVO

Limite mensal:
R$ 20,00
```

Depois da interação 10.000:

* continuar utilizando IA;
* contabilizar consumo como excedente;
* converter consumo real em valor faturável;
* descontar do limite adicional.

Exemplo:

```text
Crédito utilizado:
R$ 8,37 / R$ 20,00
```

Ao atingir R$20:

* bloquear novas gerações;
* não ultrapassar o spending cap;
* permitir aumento de limite pelo administrador autorizado.

---

# 6. Crédito ilimitado

Permitir:

```text
limitType = UNLIMITED
```

Neste modo:

* não existe spending cap;
* todo consumo excedente será faturado;
* exibir alertas de gasto mesmo assim.

Essa opção deve exigir confirmação explícita.

Mostrar aviso:

```text
O uso adicional não possuirá limite mensal e será adicionado à próxima cobrança.
```

---

# 7. Não utilizar preço fixo por mensagem internamente

NÃO assumir:

```text
1 mensagem = R$ X
```

O custo real varia de acordo com:

* modelo;
* tokens de entrada;
* tokens de saída;
* contexto;
* ferramentas;
* cache;
* tamanho das respostas.

O sistema deve calcular o consumo real.

---

# 8. Unidade comercial

Para o cliente, continuar apresentando uma unidade simples:

```text
Interações de IA
```

Uma interação corresponde a uma geração/resposta da IA.

Exemplo:

Lead envia:

```text
Oi
Tenho interesse
Quanto custa?
```

IA agrupa e responde uma vez.

Resultado:

```text
1 interação de IA
```

Não contar mensagens individuais recebidas como consumo.

---

# 9. Custos internos

Registrar para cada geração:

```text
companyId
subscriptionId
usagePeriodId
interactionId

model

inputTokens
outputTokens
cachedTokens

inputPricePerMillion
outputPricePerMillion

providerCostUsd
providerCostBrl

billableAmountBrl

createdAt
```

Usar os dados reais retornados pelo provider sempre que possível.

---

# 10. Pricing de IA

Separar:

```text
CUSTO DO PROVIDER
```

de:

```text
PREÇO COBRADO PELO ATENDON
```

Criar uma configuração comercial.

Exemplo conceitual:

```text
providerCost = R$ 0,005

markup/margem aplicada

billableAmount = R$ 0,015
```

Não hardcodar markup.

ROOT deverá conseguir editar a regra futuramente.

---

# 11. Estratégias de precificação

Preparar arquitetura para pelo menos:

```text
COST_PLUS_MARKUP
FIXED_PER_INTERACTION
CUSTOM
```

Inicialmente utilizar a estratégia considerada mais adequada após analisar o projeto.

A arquitetura deve permitir trocar depois sem perder histórico.

---

# 12. Conversão aproximada para o cliente

A interface poderá informar:

```text
R$20 em créditos ≈ 1.300 interações adicionais
```

Mas sempre apresentar como estimativa.

Não prometer quantidade fixa caso a cobrança esteja baseada em consumo real.

---

# 13. Usage Period

Criar uma entidade/período de consumo mensal.

Exemplo:

```text
UsagePeriod

companyId
subscriptionId

startAt
endAt

includedLimit
includedUsage

overageUsage
overageAmountBrl

status
```

Possíveis estados:

```text
OPEN
CLOSED
INVOICED
```

---

# 14. Reset mensal

Quando iniciar novo período:

```text
includedUsage = 0
overageUsage = 0
overageAmount = 0
```

Nunca apagar o período anterior.

Criar novo registro.

---

# 15. Usage Ledger

Não guardar somente contador final.

Criar ledger individual.

Exemplo:

```text
UsageLedger
```

Cada lançamento deve conter:

* empresa;
* período;
* interação;
* modelo;
* tokens;
* custo do provider;
* valor faturável;
* tipo de consumo.

Tipo:

```text
INCLUDED
OVERAGE
```

Isso permitirá auditoria completa.

---

# 16. Regra de transição para overage

Ao executar IA:

```text
1. Resolver entitlement da empresa.
2. Confirmar que AI está habilitada.
3. Localizar UsagePeriod atual.
4. Verificar franquia incluída.
5. Se ainda houver franquia:
   consumir INCLUDED.
6. Se franquia acabou:
   verificar Crédito de Uso.
7. Se desativado:
   recusar execução.
8. Se ativado:
   calcular custo projetado/real.
9. Verificar spending cap.
10. Executar e registrar OVERAGE.
```

---

# 17. Evitar ultrapassar limite

Exemplo:

```text
Limite:
R$20

Usado:
R$19,98
```

Uma nova chamada estimada em R$0,05 não deve permitir consumo sem controle.

Criar mecanismo seguro para impedir estouro significativo do spending cap.

Considerar:

* reserva estimada antes da geração;
* reconciliação após receber o uso real.

---

# 18. Concorrência

Tratar chamadas simultâneas.

Duas respostas de IA executadas ao mesmo tempo não podem contornar:

```text
10.000 interações
```

ou:

```text
R$20 de limite
```

Usar transações, locks ou mecanismo equivalente compatível com a arquitetura existente.

---

# 19. Configuração pelo cliente

Usuários administrativos autorizados da empresa poderão acessar:

```text
Assinatura
→ Uso de IA
→ Crédito de Uso
```

Opções:

```text
[ ] Ativar Crédito de Uso

Limite mensal:
R$20
R$50
R$100
R$200
Personalizado

ou

[ ] Sem limite
```

---

# 20. Segurança

Nem todo usuário da empresa poderá alterar gastos.

Criar permission específica:

```text
MANAGE_BILLING
```

ou equivalente compatível com RBAC atual.

Somente:

* ROOT;
* proprietário;
* administrador financeiro autorizado;

podem alterar crédito de uso.

---

# 21. Limites configuráveis pelo ROOT

ROOT deverá conseguir definir:

```text
valor mínimo
valor máximo
opções sugeridas
permitir personalizado
permitir ilimitado
```

Exemplo:

```text
mínimo: R$10
máximo configurável pelo cliente: R$1.000
```

ROOT poderá exceder esses limites manualmente.

---

# 22. Alertas da franquia

Criar alertas em:

```text
80%
90%
100%
```

Exemplo:

```text
Você utilizou 8.000 das 10.000 interações de IA incluídas neste mês.
```

Evitar envio repetitivo.

Registrar quais alertas já foram disparados no período.

---

# 23. Alertas de crédito

Depois de entrar em overage, alertar em:

```text
50%
80%
100%
```

Exemplo:

```text
Você utilizou R$16,00 dos R$20,00 definidos para Crédito de Uso neste mês.
```

---

# 24. Dashboard de consumo

Criar área semelhante a:

```text
Uso de IA

Plano Médio

Franquia:
8.412 / 10.000

84%

Renova em:
18 dias

Crédito de uso:
Ativado

Uso adicional:
R$0,00 / R$20,00
```

Depois da franquia:

```text
Franquia:
10.000 / 10.000

Crédito adicional:
R$7,82 / R$20,00
```

---

# 25. Histórico

Mostrar histórico mensal.

Exemplo:

```text
Agosto/2026

Franquia:
10.000

Uso:
12.843

Excedente:
2.843

Cobrança adicional:
R$31,72
```

---

# 26. Fatura

A invoice deve discriminar:

```text
Plano
Desconto
Uso adicional
Outros add-ons
Total
```

Exemplo:

```text
AtendON Pro
R$1.097,00

Uso adicional de IA
R$37,42

Total
R$1.134,42
```

---

# 27. Billing cycle

Adicionar suporte a:

```text
MONTHLY
QUARTERLY
YEARLY
```

A periodicidade de pagamento deve ser separada da periodicidade de consumo de IA.

---

# 28. PlanPrice

Criar/ajustar arquitetura:

```text
Plan

PlanPrice
  MONTHLY
  QUARTERLY
  YEARLY
```

Um mesmo plano pode possuir diferentes preços.

---

# 29. Preços iniciais

Utilizar inicialmente:

## Básico

```text
Mensal:
R$497
```

## Médio

```text
Mensal:
R$897
```

## Pro

```text
Mensal:
R$1.097
```

Todos os valores precisam ser editáveis pelo ROOT.

---

# 30. Desconto trimestral

Inicialmente:

```text
10%
```

Valores aproximados:

```text
Básico:
R$1.341,90 / trimestre

Médio:
R$2.421,90 / trimestre

Pro:
R$2.961,90 / trimestre
```

---

# 31. Desconto anual

Inicialmente:

```text
20%
```

Valores:

```text
Básico:
R$4.771,20 / ano

Médio:
R$8.611,20 / ano

Pro:
R$10.531,20 / ano
```

NÃO utilizar 30% inicialmente.

Mas ROOT deverá conseguir alterar o desconto.

---

# 32. Forma de cálculo

Nunca salvar apenas:

```text
desconto = 10%
```

Guardar snapshot financeiro no momento da contratação:

```text
basePrice
discountType
discountValue
finalPrice
currency
billingCycle
```

Assim uma alteração futura no preço não muda contratos já firmados sem decisão explícita.

---

# 33. Renovação

Na renovação:

## Mensal

Cobrar:

```text
mensalidade
+
overage do último período
+
add-ons
-
créditos/descontos
```

## Trimestral/anual

Definir de forma explícita no modelo se o plano já foi pré-pago.

Uso excedente NÃO deve esperar necessariamente 12 meses para cobrança.

---

# 34. Regra recomendada para overage em contratos anuais/trimestrais

Mesmo que o plano seja anual ou trimestral:

```text
Uso excedente deve ser fechado mensalmente.
```

Exemplo:

Plano Pro anual já

# 35. Rollover de franquia de IA

Adicionar ao AtendON um sistema de rollover parcial da franquia mensal de IA.

Objetivo:

Quando uma empresa não utilizar toda a franquia mensal incluída no plano, parte do saldo restante poderá ser convertida em franquia adicional para o próximo período.

Não converter esse saldo em dinheiro.

Não chamar internamente de crédito financeiro.

Utilizar conceitos separados:

```text
INCLUDED_USAGE
ROLLOVER_USAGE
OVERAGE_USAGE
```

---

# 36. Regra inicial recomendada

Utilizar inicialmente:

```text
rolloverRate = 50%
```

Exemplo:

Plano Médio:

```text
Franquia mensal:
10.000 interações

Utilizadas:
5.000

Não utilizadas:
5.000
```

Rollover:

```text
50% do saldo restante
```

Resultado:

```text
2.500 interações adicionais
```

No próximo ciclo:

```text
Franquia base:
10.000

Rollover:
2.500

Disponível:
12.500 interações
```

O rollover NÃO altera permanentemente o limite do plano.

No mês seguinte, o plano continua sendo originalmente de 10.000 interações.

---

# 37. O rollover só acontece após renovação válida

Se a empresa possui vencimento no dia 5:

```text
Dia 5
↓
renovação confirmada
↓
fecha período anterior
↓
calcula saldo elegível
↓
aplica rollover
↓
cria novo UsagePeriod
```

Não liberar rollover antes da renovação estar válida.

Se o pagamento estiver:

```text
PAST_DUE
SUSPENDED
CANCELED
```

seguir as regras de billing e não conceder novo rollover até regularização.

---

# 38. Teto de rollover

NÃO permitir acumulação infinita.

Criar configuração:

```text
rolloverMaxPercentage
```

Recomendação inicial:

```text
Máximo acumulável:
50% da franquia base do plano
```

Exemplo:

Plano Médio:

```text
Franquia:
10.000

Máximo de rollover armazenado:
5.000
```

Mesmo que cálculos históricos gerem mais saldo, a empresa nunca começa um período com mais de:

```text
10.000 base
+
5.000 rollover
=
15.000 disponíveis
```

Plano Pro:

```text
40.000 base
+
máximo 20.000 rollover
=
60.000 disponíveis
```

Esse teto deve ser configurável pelo ROOT.

---

# 39. Ordem de consumo

Definir explicitamente a ordem de consumo.

Minha recomendação:

```text
1. ROLLOVER
2. INCLUDED
3. OVERAGE
```

Utilizar rollover primeiro porque ele é saldo temporário.

Exemplo:

```text
Rollover:
2.500

Franquia do mês:
10.000
```

As primeiras 2.500 interações consomem rollover.

Depois passam a consumir as 10.000 incluídas.

Somente depois entra Crédito de Uso / overage.

---

# 40. Expiração

Rollover não deve permanecer indefinidamente.

Recomendação:

```text
validade = 1 ciclo mensal
```

Exemplo:

2.500 interações carregadas de setembro para outubro.

Se outubro terminar e ainda houver 1.000 dessas interações:

```text
expiram
```

O cálculo do novo rollover será realizado com base na franquia elegível do período, conforme a regra definida.

Isso evita acumulação de saldo durante meses.

---

# 41. Não permitir rollover sobre rollover

Por padrão:

```text
rollover não gera novo rollover
```

Somente saldo não utilizado da franquia BASE do plano é elegível.

Exemplo:

```text
Base:
10.000

Rollover recebido:
2.500

Uso total no mês:
4.000
```

Não calcular sobra em cima de 12.500.

Calcular conforme consumo elegível da franquia base.

Isso impede crescimento artificial de saldo.

---

# 42. Overage não gera rollover

Interações compradas através do Crédito de Uso:

```text
OVERAGE
```

nunca geram saldo para o próximo mês.

São cobrança variável daquele período.

---

# 43. Configuração por plano

Adicionar configurações como:

```text
rolloverEnabled

rolloverRate

rolloverMaxPercentage

rolloverExpirationPeriods
```

Exemplo:

```text
BÁSICO
rolloverEnabled = false

MÉDIO
rolloverEnabled = true
rolloverRate = 50%
rolloverMaxPercentage = 50%
rolloverExpirationPeriods = 1

PRO
rolloverEnabled = true
rolloverRate = 50%
rolloverMaxPercentage = 50%
rolloverExpirationPeriods = 1
```

ROOT deve conseguir modificar esses valores.

---

# 44. Possível diferenciação comercial futura

A arquitetura deve permitir futuramente algo como:

```text
Médio:
25% de rollover

Pro:
50% de rollover
```

ou:

```text
Médio:
validade de 1 mês

Pro:
validade de 2 meses
```

NÃO implementar obrigatoriamente essa diferenciação agora.

Apenas deixar a estrutura preparada.

---

# 45. Exibição para o usuário

Na tela de consumo:

```text
Uso de IA

Plano Médio

Franquia do mês:
10.000

Créditos acumulados:
2.500

Total disponível:
12.500

Utilizado:
4.820
```

Evitar chamar de:

```text
R$ de crédito
```

Usar:

```text
Créditos de IA
Interações acumuladas
Franquia acumulada
```

---

# 46. Previsão de rollover

Antes do fechamento do período, poderá mostrar:

```text
Saldo atual:
5.000 interações

Se o período encerrasse hoje:
2.500 interações seriam acumuladas para o próximo mês.
```

Isso melhora percepção de valor do plano.

---

# 47. Histórico de rollover

Registrar:

```text
RolloverLedger

companyId
usagePeriodId
sourcePeriodId

unusedIncludedUsage
rolloverRate
generatedAmount
expiredAmount
consumedAmount

createdAt
expiresAt
```

O sistema deverá permitir explicar exatamente de onde veio o saldo.

---

# 48. Auditoria

Registrar eventos:

```text
ROLLOVER_GENERATED
ROLLOVER_CONSUMED
ROLLOVER_EXPIRED
ROLLOVER_ADJUSTED_BY_ROOT
```

Nunca alterar saldo silenciosamente.

---

# 49. Ajustes manuais pelo ROOT

ROOT poderá conceder franquia promocional.

Exemplo:

```text
+5.000 interações
Motivo:
Crédito comercial / compensação
```

Separar isso de rollover.

Criar tipo:

```text
BONUS_USAGE
```

Assim existirão:

```text
INCLUDED
ROLLOVER
BONUS
OVERAGE
```

---

# 50. Ordem completa de consumo

Recomendação:

```text
1. ROLLOVER prestes a expirar
2. BONUS prestes a expirar
3. INCLUDED
4. OVERAGE
```

Se existirem múltiplos saldos, utilizar primeiro o que expira antes.

---

# 51. Grace period de pagamento

Se o cliente tem vencimento dia 5 e o pagamento falha, não destruir saldo imediatamente.

Seguir o grace period da assinatura.

Exemplo:

```text
Dia 5:
pagamento falhou

Status:
PAST_DUE

Grace period:
3 dias
```

Durante o período de tolerância, preservar contabilização e decidir conforme política existente se IA continua ou fica limitada.

Quando o pagamento for aprovado:

* fechar corretamente o período anterior;
* conceder rollover elegível;
* iniciar novo período.

---

# 52. Mudança de plano com rollover

Tratar upgrade e downgrade.

## Upgrade

Exemplo:

```text
Médio → Pro
```

Não perder rollover válido automaticamente.

Aplicar regras do novo plano no próximo período ou conforme política de proration.

## Downgrade

Exemplo:

```text
Pro → Médio
```

O rollover existente deverá respeitar o teto do novo plano.

Nunca apagar silenciosamente.

Registrar ajuste em auditoria.

---

# 53. Cancelamento

Ao cancelar assinatura:

* impedir geração de novos rollovers;
* definir expiração do saldo restante;
* não transformar rollover em valor financeiro;
* não permitir saque;
* não permitir reembolso do rollover.

Rollover é benefício de uso do SaaS, não moeda.

---

# 54. Regra financeira

Rollover NÃO reduz a mensalidade.

Exemplo:

Cliente utilizou somente 5.000 de 10.000.

Ele continua pagando:

```text
R$897
```

O benefício recebido é:

```text
+2.500 interações para o próximo período
```

Nunca:

```text
desconto financeiro proporcional
```

---

# 55. Métricas ROOT

Adicionar métricas:

```text
franquia concedida
franquia consumida
rollover gerado
rollover utilizado
rollover expirado
overage gerado
receita de overage
custo real de IA
```

Por:

* empresa;
* plano;
* mês.

Isso será importante para descobrir se 50% de rollover é financeiramente saudável.

---

# 56. Configuração global

Criar configurações globais, sem hardcode:

```text
defaultRolloverRate = 50%

defaultRolloverMaxPercentage = 50%

defaultRolloverExpirationPeriods = 1
```

Planos poderão sobrescrever esses valores.

---

# 57. Testes obrigatórios de rollover

Criar testes para:

* cliente utiliza toda franquia → rollover 0;
* cliente utiliza metade → rollover correto;
* cliente não utiliza nada → respeita teto;
* rollover expira corretamente;
* rollover não gera rollover infinito;
* overage não gera rollover;
* bonus não é confundido com rollover;
* pagamento não confirmado não gera rollover indevidamente;
* renovação não duplica rollover;
* webhook repetido não gera saldo duas vezes;
* chamadas simultâneas não geram inconsistência;
* mudança de plano respeita novo teto;
* ROOT consegue auditar e ajustar.

---

# 58. Regra de produto recomendada inicialmente

Começar com:

```text
ROLLOVER:
50% do saldo mensal não utilizado

TETO:
50% da franquia base

VALIDADE:
1 mês

OVERAGE:
não acumula

ROLLOVER:
não gera novo rollover

PAGAMENTO:
renovação válida necessária
```

Não tornar essas regras permanentes no código.

Tudo deve ser configurável.

---

# 59. Objetivo comercial

Esse recurso deve melhorar:

* percepção de justiça;
* retenção;
* valor percebido do plano;
* redução da sensação de "perdi o que não usei";
* incentivo à renovação;
* diferenciação frente a CRMs tradicionais.

Ao mesmo tempo, proteger:

* margem;
* infraestrutura;
* custo de IA;
* previsibilidade financeira.

O sistema deve privilegiar sustentabilidade do SaaS, não apenas oferecer o máximo possível ao cliente.

# 60. Billing Providers configuráveis pelo painel

Adicionar uma área ROOT:

```text
ROOT
→ SaaS
→ Gateways de pagamento
```

O objetivo é evitar depender de:

```text
.env
arquivos de configuração
deploy
edição manual no servidor
```

para alterar credenciais ou configurações comerciais dos gateways.

---

# 61. Mercado Pago primeiro

Implementar inicialmente apenas:

```text
Mercado Pago
```

Preparar a arquitetura para futuramente receber:

```text
Stripe
InfinitePay
PagBank
outros providers
```

Mas NÃO implementar as integrações completas desses providers nesta etapa.

---

# 62. Abstração

Manter:

```text
BillingProvider
```

com providers independentes:

```text
MercadoPagoProvider
StripeProvider // futuro
InfinitePayProvider // futuro
PagBankProvider // futuro
```

O restante do sistema não deve depender diretamente da SDK do Mercado Pago.

---

# 63. Configuração do Mercado Pago pelo painel

Criar tela:

```text
Mercado Pago

Status:
Não conectado / Conectado / Erro

Ambiente:
Sandbox
Produção

[Conectar Mercado Pago]
```

Sempre que possível, preferir OAuth em vez de exigir que o ROOT copie tokens manualmente.

---

# 64. OAuth do Mercado Pago

Investigar a documentação atual oficial do Mercado Pago antes da implementação.

Implementar o fluxo OAuth adequado para integração de aplicações.

Fluxo esperado:

```text
ROOT
↓
Conectar Mercado Pago
↓
redirecionamento para autorização
↓
Mercado Pago
↓
callback seguro
↓
troca do authorization code
↓
credenciais armazenadas com segurança
↓
status: CONECTADO
```

Implementar:

* state anti-CSRF;
* callback validation;
* tratamento de erro;
* refresh token, se fornecido;
* renovação de token;
* expiração;
* revogação;
* reconexão.

Nunca confiar apenas no frontend para o fluxo OAuth.

---

# 65. Client ID / Client Secret

Se o Mercado Pago exigir credenciais da aplicação para iniciar OAuth, permitir configuração inicial pelo painel ROOT.

Exemplo:

```text
Client ID
[________________]

Client Secret
[________________]
```

Mas aplicar proteção especial.

Depois de salvo:

```text
Client ID:
123456789

Client Secret:
••••••••••••••7F2A
```

Nunca devolver o secret completo novamente pela API.

ROOT poderá:

```text
Substituir credencial
```

mas não visualizar o valor original.

---

# 66. Access Token manual como fallback

Se tecnicamente necessário, oferecer:

```text
Configuração avançada
→ Access Token manual
```

Mas OAuth deve ser preferido quando adequado.

O painel poderá aceitar:

```text
Access Token
Public Key
Client ID
Client Secret
```

somente conforme realmente necessário pela integração.

Não criar campos desnecessários.

---

# 67. Armazenamento seguro

Credenciais de gateway NÃO devem ficar em plaintext no banco.

Criar serviço de secrets:

```text
BillingSecretsService
```

Armazenar credenciais utilizando criptografia autenticada.

Exemplo conceitual:

```text
AES-256-GCM
```

ou solução equivalente segura disponível na stack.

O banco deverá conter apenas o valor criptografado.

---

# 68. Chave mestra

Existe uma diferença importante:

As credenciais específicas dos gateways podem ficar no banco criptografadas.

Porém deve existir uma **root encryption key** fora do próprio banco.

Não armazenar:

```text
chave que criptografa secrets
+
secrets criptografados
```

na mesma estrutura sem proteção adicional.

Se a infraestrutura atual permitir secret manager, utilizar.

Caso contrário, manter somente UMA chave de infraestrutura segura como requisito operacional.

O objetivo é evitar dezenas de configurações no `.env`, mas não sacrificar segurança para eliminar completamente qualquer secret de infraestrutura.

---

# 69. Regra importante

Não tentar tornar literalmente 100% das credenciais configuráveis pelo painel se isso exigir armazenar a chave mestra junto das próprias credenciais.

O ideal é:

```text
ENV / Secret Manager:
1 chave mestra da aplicação

Banco criptografado:
Mercado Pago
Stripe
InfinitePay
PagBank
etc.
```

Assim novas integrações não exigem editar `.env`.

---

# 70. Teste de conexão

Adicionar:

```text
[Testar conexão]
```

Resultado:

```text
Mercado Pago conectado com sucesso.
```

ou:

```text
Falha na autenticação.

Verifique as credenciais ou reconecte a conta.
```

Nunca mostrar token em logs ou mensagens de erro.

---

# 71. Dados do vínculo

Mostrar:

```text
Mercado Pago
Conectado

Conta:
<identificação retornada pela API>

Ambiente:
Produção

Conectado em:
04/09/2026

Última validação:
04/09/2026 21:30
```

Se a API disponibilizar com segurança:

```text
email da conta
user ID
country
```

poderá mostrar para ajudar o ROOT a saber qual conta está vinculada.

---

# 72. Desconectar

Adicionar:

```text
[Desconectar Mercado Pago]
```

Exigir confirmação.

Ao desconectar:

* revogar token quando suportado;
* apagar ou invalidar credenciais armazenadas;
* manter histórico financeiro;
* não apagar pagamentos existentes;
* bloquear criação de novas cobranças pelo provider.

---

# 73. Webhooks

Configurar webhooks do Mercado Pago de forma centralizada.

Painel:

```text
Webhook

Status:
Ativo

URL:
https://.../billing/webhooks/mercadopago

Último evento:
...

Último erro:
...
```

Não exigir que o ROOT copie URL manualmente se a API permitir configuração automatizada.

Se configuração manual for necessária, mostrar instruções claras no painel.

---

# 74. Segurança de webhook

Implementar conforme documentação oficial atual do Mercado Pago:

* validação de autenticidade;
* idempotência;
* deduplicação;
* timestamp;
* event ID;
* logs;
* retries seguros.

Nunca considerar um pagamento aprovado apenas porque o frontend informou sucesso.

Sempre confirmar no backend/provider.

---

# 75. Métodos de pagamento

Depois da conexão, ROOT poderá habilitar os métodos realmente suportados:

```text
PIX
Cartão
Boleto
Assinatura recorrente
```

Não assumir suporte sem validar a API atual.

Mostrar apenas métodos disponíveis para aquela configuração.

---

# 76. Configuração comercial

Separar credenciais de configurações.

Exemplo:

```text
Credenciais
OAuth / Tokens

Configuração
Moeda
Métodos habilitados
Prazo do PIX
Prazo do boleto
Grace period
Cobrança automática
```

Assim alterar uma regra comercial não exige reconectar o gateway.

---

# 77. Ambientes

Suportar:

```text
SANDBOX
PRODUCTION
```

Nunca misturar transações dos ambientes.

Cada ambiente deve possuir configuração própria.

Exemplo:

```text
Mercado Pago Sandbox
Mercado Pago Produção
```

---

# 78. Status do provider

Criar estados:

```text
NOT_CONFIGURED
CONNECTED
TOKEN_EXPIRING
AUTH_ERROR
DISCONNECTED
DISABLED
```

O sistema deverá detectar quando a integração parar de funcionar.

---

# 79. Logs administrativos

Registrar:

```text
GATEWAY_CONNECTED
GATEWAY_DISCONNECTED
GATEWAY_CREDENTIAL_ROTATED
GATEWAY_AUTH_FAILED
GATEWAY_WEBHOOK_RECEIVED
GATEWAY_WEBHOOK_FAILED
```

Nunca registrar secrets.

---

# 80. Permissões

Somente ROOT deverá inicialmente conseguir:

* conectar gateway;
* alterar credenciais;
* trocar ambiente;
* desconectar;
* alterar configurações globais.

Não permitir que admins normais das empresas modifiquem o gateway central do AtendON.

---

# 81. Stripe, InfinitePay e PagBank

Criar apenas placeholders estruturais no painel:

```text
Stripe
Em breve

InfinitePay
Em breve

PagBank
Em breve
```

ou simplesmente manter suporte no backend sem mostrar opções ao usuário.

Não implementar OAuth nem APIs deles nesta tarefa.

Apenas garantir que a arquitetura criada para Mercado Pago não impeça providers futuros.

---

# 82. Critério de conclusão

Considerar esta parte concluída quando:

* ROOT consegue configurar Mercado Pago sem editar código;
* OAuth funciona se aplicável;
* credenciais ficam protegidas;
* conexão pode ser testada;
* webhook funciona;
* cobranças podem utilizar a configuração ativa;
* tokens não aparecem no frontend;
* alteração de credencial não exige deploy;
* desconexão funciona;
* sandbox/produção são separados;
* testes automatizados cobrem autenticação, armazenamento, webhook e falhas.