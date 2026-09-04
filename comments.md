# Objetivo

Transformar o AtendON atual em uma arquitetura SaaS multiempresa com:

* gestão central de planos pelo usuário ROOT;
* planos Básico, Médio e Pro pré-configurados;
* limites por empresa;
* liberação/bloqueio automático de funcionalidades;
* controle de consumo;
* assinatura e cobrança;
* múltiplos meios de pagamento;
* estrutura preparada para futura venda automática pelo site;
* sem desenvolver o site público de vendas nesta etapa.

O sistema atual deve continuar funcionando durante a implementação.

Antes de alterar qualquer código, analise completamente o projeto existente, banco de dados, models, serviços, autenticação, permissões, multiempresa, frontend, backend e integrações.

Não faça refatorações grandes que não sejam necessárias para o SaaS.

---

# 1. Conceito principal

Cada empresa/tenant cadastrada no AtendON deverá possuir:

* um plano;
* uma assinatura;
* um status de cobrança;
* limites de utilização;
* funcionalidades habilitadas;
* consumo atual do período;
* datas de início e renovação;
* histórico de mudanças de plano.

A empresa nunca deverá decidir suas próprias permissões.

Somente ROOT poderá:

* criar planos;
* editar planos;
* alterar limites;
* alterar preços;
* habilitar/desabilitar funcionalidades;
* vincular plano a uma empresa;
* trocar plano;
* conceder exceções;
* suspender assinatura;
* visualizar consumo;
* visualizar cobrança.

---

# 2. Não usar verificações fixas por nome de plano

NÃO implementar regras espalhadas como:

```typescript
if (company.plan === "PRO")
```

Criar uma arquitetura de:

* plans;
* features;
* entitlements;
* limits;
* usage.

Exemplo:

```text
conversations.enabled = true
pipeline.enabled = true
calendar.enabled = false
ai.enabled = false

users.max = 3
whatsappConnections.max = 1
pipelines.max = 1
aiInteractions.monthly = 0
```

Assim o ROOT poderá futuramente criar:

* Enterprise;
* Trial;
* Plano personalizado;
* Plano legado;
* parceiros;
* condições comerciais específicas;

sem precisar alterar código.

---

# 3. Planos iniciais

Criar automaticamente três planos.

## BÁSICO — R$ 497/mês

Objetivo:
empresa que quer CRM/atendimento sem IA.

Inicialmente:

* Conversas: habilitado
* Pipeline: habilitado
* Agenda: bloqueada
* IA: bloqueada
* Follow-up automático: bloqueado
* Automações avançadas: bloqueadas
* Relatórios: básicos
* Usuários: até 3
* WhatsApps: até 1
* Pipelines: até 1
* IA mensal: 0
* Permissões avançadas: bloqueadas

---

## MÉDIO — R$ 897/mês

Deve ser o plano comercial principal.

Inicialmente:

* Conversas: habilitado
* Pipeline: habilitado
* Agenda: habilitada
* IA: habilitada
* Follow-up automático: habilitado
* Automações: limitadas
* Relatórios: completos
* Usuários: até 8
* WhatsApps: até 2
* Pipelines: até 3
* IA: até 10.000 interações mensais
* Cargos/permissões: habilitado
* Suporte: prioritário

---

## PRO — R$ 1.097/mês

Deve possuir grande vantagem em relação ao Médio.

Inicialmente:

* Conversas: habilitado
* Pipeline: habilitado
* Agenda: habilitada
* IA: habilitada
* Follow-up completo
* Automações completas
* Relatórios avançados
* Usuários: até 20
* WhatsApps: até 5
* Pipelines: até 10
* IA: inicialmente 40.000 interações mensais
* Permissões avançadas
* Recursos administrativos avançados
* Suporte prioritário

Esses números NÃO deverão ficar hardcoded.

O ROOT deverá conseguir editar todos eles.

---

# 4. Features

Analise o projeto inteiro e liste todas as funcionalidades existentes no AtendON.

Transforme tudo que puder ser comercialmente limitado em feature ou entitlement.

Exemplos:

```text
CONVERSATIONS
PIPELINE
CALENDAR
AI
AI_FOLLOWUP
AUTOMATIONS
REPORTS
ADVANCED_REPORTS
MULTIPLE_PIPELINES
ROLES_PERMISSIONS
WHATSAPP_CONNECTIONS
CONTACT_IMPORT
CONTACT_EXPORT
CUSTOM_FIELDS
WEBHOOKS
API_ACCESS
INTEGRATIONS
TAGS
SCHEDULE
LEAD_DISTRIBUTION
SDR_PIPELINE
CLOSER_PIPELINE
AI_CONFIGURATION
CUSTOM_AI_PROMPT
```

Não invente funcionalidades existentes.

Se identificar uma funcionalidade interessante que ainda não existe, marque como:

```text
FUTURE_FEATURE
```

e não implemente agora.

---

# 5. Entitlements

Criar uma camada central para resolver:

```text
Empresa X pode utilizar recurso Y?
Empresa X atingiu limite Z?
```

Exemplo conceitual:

```typescript
entitlements.can(companyId, "CALENDAR")

entitlements.getLimit(companyId, "USERS")

entitlements.getUsage(companyId, "AI_INTERACTIONS")

entitlements.hasReachedLimit(
  companyId,
  "WHATSAPP_CONNECTIONS"
)
```

Toda aplicação deverá consultar a mesma fonte de verdade.

---

# 6. Enforcement obrigatório no backend

Bloquear somente visualmente no frontend NÃO é suficiente.

Toda funcionalidade restrita deverá possuir validação no backend.

Exemplo:

Empresa Básico tenta acessar diretamente:

```text
POST /calendar/events
```

Resultado esperado:

```text
403 FEATURE_NOT_AVAILABLE
```

Empresa atingiu limite:

```text
409 PLAN_LIMIT_REACHED
```

Nunca confiar apenas na interface.

---

# 7. Frontend

No frontend:

* esconder funcionalidades quando fizer sentido;
* mostrar recursos bloqueados quando isso ajudar no upsell;
* apresentar indicação do plano necessário;
* bloquear ações que ultrapassam limite.

Exemplo:

```text
Agenda

Disponível a partir do plano Médio.

[Ver plano]
```

Mas NÃO desenvolver nesta etapa o checkout público.

---

# 8. Painel ROOT

Criar uma área:

```text
ROOT
 └── SaaS
      ├── Planos
      ├── Empresas
      ├── Assinaturas
      ├── Cobranças
      ├── Consumo
      ├── Gateways
      └── Histórico
```

## Planos

ROOT deverá conseguir:

* criar;
* editar;
* arquivar;
* duplicar;
* definir preço;
* definir periodicidade;
* habilitar features;
* definir limites.

Evitar apagar definitivamente plano que já tenha histórico.

Usar arquivamento.

---

# 9. Empresa

Na administração de uma empresa mostrar:

```text
Empresa
Plano atual
Valor
Status
Gateway
Data da próxima cobrança
Usuários: 5 / 8
WhatsApps: 2 / 2
Pipelines: 2 / 3
IA: 7.823 / 10.000
```

Permitir:

* trocar plano;
* definir plano personalizado;
* aplicar desconto;
* conceder limite adicional;
* suspender;
* reativar;
* consultar cobrança.

---

# 10. Overrides

Criar possibilidade de exceções por empresa.

Exemplo:

Empresa está no Médio:

```text
users.max = 8
```

Mas ROOT concede:

```text
users.max = 12
```

Não criar um novo plano só por causa disso.

Estrutura:

```text
Plan
      ↓
Entitlements
      ↓
Company Overrides
      ↓
Effective Entitlements
```

---

# 11. Assinaturas

Criar entidade própria de subscription.

Possíveis estados:

```text
TRIALING
ACTIVE
PAST_DUE
GRACE_PERIOD
SUSPENDED
CANCELED
EXPIRED
```

Uma empresa não deve perder acesso imediatamente por uma falha pontual de pagamento.

Criar período de tolerância configurável.

Exemplo:

```text
Vencimento
↓
Pagamento falhou
↓
PAST_DUE
↓
Grace period
↓
Nova tentativa
↓
SUSPENDED
```

O ROOT poderá reativar manualmente.

---

# 12. Pagamentos

Não acoplar assinatura diretamente ao Mercado Pago ou Stripe.

Criar abstração:

```typescript
BillingProvider
```

Exemplo conceitual:

```typescript
interface BillingProvider {
  createCustomer()
  createSubscription()
  cancelSubscription()
  createPayment()
  getPayment()
  handleWebhook()
}
```

Providers poderão ser:

```text
MercadoPagoProvider
StripeProvider
PagBankProvider
ManualPixProvider
```

Assim novos meios de pagamento podem ser adicionados futuramente.

---

# 13. Mercado Pago

Preparar integração para:

* cartão;
* assinatura recorrente, quando aplicável;
* boleto, se utilizado;
* Pix;
* webhook;
* atualização automática da assinatura.

Credenciais nunca deverão ficar expostas no frontend.

---

# 14. Stripe

Preparar arquitetura para:

* Customer;
* Subscription;
* Payment Intent;
* webhook;
* recorrência;
* cancelamento;
* falha de cobrança.

Mesmo que Stripe não seja ativado imediatamente, a arquitetura deverá aceitá-lo.

---

# 15. PagBank

Seguir a mesma abstraction do BillingProvider.

Não espalhar chamadas específicas do PagBank pelo projeto.

---

# 16. PIX manual / QR Code

Também permitir cobrança sem gateway recorrente.

Exemplo:

ROOT configura:

```text
Tipo: PIX
Chave PIX
Nome recebedor
Cidade
```

Sistema poderá gerar:

* QR Code;
* PIX Copia e Cola;
* valor;
* vencimento.

No pagamento manual deverá existir:

```text
Aguardando confirmação
Pago
Rejeitado
Expirado
```

ROOT poderá confirmar pagamento manualmente.

Se posteriormente houver API do provedor, poderá ser automatizado.

---

# 17. Configuração de gateways

ROOT deverá possuir configuração central:

```text
Gateway ativo
Ambiente sandbox/produção
Credenciais
Webhook status
Última comunicação
Métodos aceitos
```

Segredos precisam ser armazenados de forma segura.

Nunca retornar secret keys via API para frontend.

No frontend mostrar algo como:

```text
••••••••••7HsA
```

---

# 18. Webhooks

Implementar corretamente:

* validação de assinatura;
* idempotência;
* prevenção de evento duplicado;
* logs;
* retry seguro;
* associação com empresa/assinatura.

Um webhook repetido nunca poderá:

* duplicar pagamento;
* duplicar assinatura;
* renovar duas vezes;
* alterar plano incorretamente.

Criar tabela/event log apropriada.

---

# 19. Cobranças

Criar histórico de:

```text
Invoices / Charges
```

Guardar pelo menos:

* companyId;
* subscriptionId;
* provider;
* externalId;
* valor;
* moeda;
* status;
* vencimento;
* pagamento;
* método;
* metadata.

---

# 20. Controle de IA

Não controlar apenas quantidade de mensagens.

Registrar também:

```text
aiInteractions
inputTokens
outputTokens
cachedTokens
estimatedCostUsd
model
companyId
timestamp
```

A franquia comercial poderá continuar sendo mostrada ao cliente como:

```text
10.000 interações de IA/mês
```

Mas internamente o sistema precisa conhecer o custo real.

Criar contador por billing period.

---

# 21. Definição de interação de IA

Definir uma interação como uma geração/resposta realizada pela IA.

Exemplo:

Lead envia:

```text
Oi
Tenho interesse
Quanto custa?
```

O AtendON processa tudo e gera uma única resposta.

Resultado:

```text
1 AI interaction
```

Não 4 mensagens.

Verifique a arquitetura atual antes de definir o ponto exato de contabilização.

---

# 22. Limites

Criar infraestrutura genérica para limites.

Exemplos:

```text
MAX_USERS
MAX_WHATSAPP_CONNECTIONS
MAX_PIPELINES
MAX_AI_INTERACTIONS
MAX_AUTOMATIONS
MAX_CONTACTS
MAX_STORAGE
MAX_CUSTOM_FIELDS
```

Nem todos precisam ser comercializados agora.

Mas a arquitetura deverá permitir adicionar limites novos facilmente.

---

# 23. Controle de concorrência

Limites não podem sofrer race conditions.

Exemplo:

Limite:

```text
5 WhatsApps
```

Duas requisições simultâneas não podem criar WhatsApp 6 e 7.

Aplicar validação transacional quando necessário.

---

# 24. Upgrade

Upgrade:

```text
Básico → Médio
Médio → Pro
```

Deve liberar features automaticamente.

Não apagar configurações anteriores.

---

# 25. Downgrade

Downgrade precisa ser tratado cuidadosamente.

Exemplo:

Empresa Pro possui:

```text
15 usuários
```

Downgrade para Médio:

```text
limite = 8
```

NÃO apagar 7 usuários automaticamente.

Marcar:

```text
OVER_LIMIT
```

Bloquear criação de novos recursos e permitir que administrador escolha quais manter/arquivar.

Mesma regra para:

* WhatsApps;
* pipelines;
* automações;
* integrações;
* outros limites.

---

# 26. Cancelamento

Cancelamento não deve destruir dados.

Empresa cancelada:

```text
subscription = CANCELED
```

Dados permanecem armazenados conforme política definida.

ROOT poderá reativar.

Planejar futuramente retenção e exclusão de dados.

---

# 27. Auditoria

Registrar alterações sensíveis:

```text
ROOT alterou plano
ROOT alterou limite
ROOT concedeu override
ROOT suspendeu empresa
Pagamento aprovado
Pagamento recusado
Plano alterado
Gateway alterado
```

Guardar:

* usuário;
* empresa;
* ação;
* antes;
* depois;
* timestamp.

---

# 28. Segurança B2B

Adicionar/garantir:

* isolamento completo entre tenants;
* autorização por empresa;
* autorização por cargo;
* rate limiting;
* logs;
* auditoria;
* secrets fora do frontend;
* validação server-side;
* prevenção contra alteração de companyId;
* prevenção contra privilege escalation.

Um administrador de uma empresa nunca poderá modificar assinatura, plano ou limites por chamadas diretas à API.

---

# 29. Gestão de usuários

Planos deverão limitar usuários ativos.

Definir claramente estados:

```text
ACTIVE
INVITED
DISABLED
```

Decidir pelo código existente quais entram na franquia.

Sugestão:

somente usuários ACTIVE consomem limite.

---

# 30. Ciclo mensal

Criar período de consumo:

```text
billingPeriodStart
billingPeriodEnd
```

Ao iniciar novo período:

* IA volta para zero;
* demais métricas mensais voltam para zero;
* histórico anterior permanece salvo.

Não apagar dados históricos.

---

# 31. Métricas internas

ROOT deverá conseguir visualizar posteriormente:

```text
MRR
ARR
Clientes ativos
Clientes por plano
Churn
ARPU
Receita
Custo estimado de IA
Margem estimada por empresa
Uso médio de IA
Uso médio por plano
```

Nesta etapa, implemente apenas aquilo que for simples e necessário para estruturar corretamente os dados.

Não transforme esta fase em projeto de BI.

---

# 32. Cupons e descontos

Preparar modelo para:

```text
desconto percentual
desconto fixo
valor personalizado
data de expiração
```

Não precisa desenvolver sistema comercial completo de cupons agora se aumentar muito o escopo.

Porém a assinatura não deve pressupor que todo cliente paga exatamente o preço padrão do plano.

---

# 33. Implantação/setup fee

Separar:

```text
mensalidade
```

de:

```text
taxa de implantação
```

Plano poderá ter:

```text
monthlyPrice
setupPrice
```

ROOT poderá substituir esses valores por empresa.

---

# 34. Add-ons

Preparar a arquitetura para add-ons futuros.

Exemplos:

```text
+ usuários
+ números de WhatsApp
+ franquia de IA
+ pipelines
+ armazenamento
+ automações
```

Não é necessário comercializar add-ons agora.

Mas não construir uma arquitetura que impeça isso depois.

---

# 35. Feature flags x plano

Separar:

### Feature flag

Controla se determinada funcionalidade existe/está disponível no produto.

### Plan entitlement

Controla se determinada empresa tem direito ao recurso.

Exemplo:

```text
Feature flag:
AI_FOLLOWUP está operacional.

Entitlement:
Plano Básico não possui AI_FOLLOWUP.
```

---

# 36. Banco de dados

Após analisar o schema atual, proponha migrations compatíveis com a arquitetura existente.

Entidades esperadas, ajustando nomes ao padrão atual:

```text
plans
plan_features
plan_limits
company_subscriptions
company_entitlement_overrides
usage_records
billing_accounts
billing_providers
payments
invoices
billing_events
audit_logs
```

Evitar duplicação desnecessária.

---

# 37. Seed inicial

Criar migration/seed seguro com:

```text
BASIC
MEDIUM
PRO
```

Não criar pelo nome visual como chave principal.

Usar IDs/UUIDs ou códigos imutáveis apropriados.

O nome mostrado:

```text
Básico
Médio
Pro
```

poderá mudar futuramente sem quebrar regras.

---

# 38. Compatibilidade das empresas atuais

Existe empresa utilizando o AtendON atualmente.

A migration NÃO pode remover ou bloquear acidentalmente sua operação.

Antes da ativação:

* identificar tenants existentes;
* atribuir plano adequado;
* preservar recursos atuais;
* criar migration/backfill seguro.

Se houver dúvida sobre o plano atual, utilizar um plano/override temporário que preserve todos os acessos até configuração manual pelo ROOT.

---

# 39. UX para limite atingido

Nunca apresentar erro técnico bruto.

Exemplo:

```text
Você atingiu o limite de 8 usuários do seu plano.

Plano atual: Médio
Uso: 8/8

Para adicionar novos usuários, aumente seu limite ou faça upgrade.
```

Mesma ideia para:

* IA;
* WhatsApps;
* pipelines;
* etc.

---

# 40. Observabilidade

Registrar erros relacionados a:

* cobrança;
* webhook;
* entitlement;
* limite;
* reset de consumo;
* pagamentos;
* alteração de plano.

Não registrar tokens, secrets ou informações financeiras sensíveis.

---

# 41. Testes obrigatórios

Criar testes para pelo menos:

### Planos

* Básico não acessa IA.
* Básico não acessa agenda.
* Médio acessa IA.
* Pro acessa tudo configurado.

### Limites

* usuário 4 no Básico é recusado;
* segundo WhatsApp no Básico é recusado;
* interação acima da franquia é recusada/tratada corretamente.

### Overrides

* limite personalizado prevalece sobre plano.

### Assinatura

* ACTIVE possui acesso;
* PAST_DUE segue grace period;
* SUSPENDED segue regras definidas.

### Pagamentos

* webhook duplicado não duplica pagamento;
* aprovação atualiza assinatura;
* falha não marca pagamento como aprovado.

### Segurança

* usuário de empresa A não consulta plano/consumo privado de B;
* admin normal não altera subscription;
* manipulação direta de endpoints não contorna entitlement.

---

# 42. Rollout

Não ativar tudo de uma vez.

Implementar aproximadamente nesta sequência:

## Fase 1 — análise

Mapear arquitetura atual.

## Fase 2 — domínio SaaS

Plans, features, limits, entitlements.

## Fase 3 — ROOT

Interface e endpoints de administração.

## Fase 4 — enforcement

Aplicar bloqueios no backend.

## Fase 5 — frontend

Aplicar UX de bloqueio e limites.

## Fase 6 — usage

Adicionar contadores e IA.

## Fase 7 — billing

Subscriptions, payments e providers.

## Fase 8 — gateways

Começar pelo gateway mais adequado à arquitetura atual e deixar os demais plugáveis.

## Fase 9 — testes

Cobrir plano, limites, cobrança e isolamento.

## Fase 10 — migração

Associar empresas atuais sem interrupção.

---

# 43. FORA DO ESCOPO DESTA IMPLEMENTAÇÃO

IMPORTANTE:

NÃO criar agora o site comercial público do AtendON.

NÃO criar ainda:

* landing page;
* página pública de preços;
* cadastro self-service;
* checkout público;
* onboarding automático;
* criação automática da empresa após pagamento;
* trial público;
* aquisição automática sem vendedor.

Apenas preparar o backend para que isso seja possível depois.

Após esta implementação será criado um SEGUNDO PLANO específico para:

```text
AtendON Self-Service / Site Comercial
```

Esse segundo projeto deverá permitir futuramente:

```text
Visitante acessa atendon.com
↓
Compara Básico / Médio / Pro
↓
Escolhe plano
↓
Cria conta
↓
Escolhe pagamento
↓
Paga
↓
Empresa é criada
↓
Plano é vinculado
↓
Onboarding começa
↓
Cliente começa a utilizar o AtendON
```

NÃO implementar esse fluxo nesta tarefa.

---

# 44. Antes de escrever código

Primeiro entregue um relatório contendo:

1. Como o multi-tenant funciona atualmente.
2. Como empresas são identificadas.
3. Como usuários e cargos estão estruturados.
4. Todos os módulos encontrados.
5. Quais recursos podem virar entitlements.
6. Quais recursos possuem limites naturais.
7. Como a IA é chamada atualmente.
8. Onde contabilizar corretamente uma interação.
9. Como WhatsApps são vinculados.
10. Como pipeline e agenda estão estruturados.
11. Riscos de regressão.
12. Models/tabelas que precisarão ser criados ou alterados.
13. Endpoints novos.
14. Telas novas.
15. Estratégia de migration.
16. Estratégia para preservar empresas existentes.

Depois disso, apresente o plano de implementação detalhado por arquivos/componentes.

Somente depois avance para implementação.

---

# Princípios obrigatórios

Priorizar:

* segurança;
* isolamento entre empresas;
* organização;
* manutenção;
* extensibilidade;
* consistência;
* transações;
* idempotência;
* tipagem;
* testes;
* baixo acoplamento.

Evitar:

* hardcode de planos;
* permissões apenas no frontend;
* lógica comercial espalhada;
* gateway acoplado ao domínio;
* exclusão automática em downgrade;
* alteração destrutiva de empresas atuais;
* duplicação de lógica;
* migrations irreversíveis desnecessárias.

O objetivo não é simplesmente adicionar três planos.

O objetivo é transformar o AtendON em uma base SaaS profissional, onde planos, limites, consumo, cobrança e funcionalidades possam evoluir sem exigir reconstrução da aplicação.
