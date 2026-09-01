1. Manter a qualificação curta

Depois que a IA já entende nome + negócio + dor, faltariam apenas duas perguntas comerciais realmente importantes.

Pergunta 1 — Decisor

“Uma parceria como essa depende só de você ou mais alguém participa da decisão?”

Se disser sócio:

“Nesse caso, o ideal é ele participar da conversa também, assim vocês conseguem avaliar tudo juntos e evitamos você ter que repassar a apresentação depois”

E encerra. Não faz outra pergunta no mesmo turno.

Pergunta 2 — Momento

“Se a solução fizer sentido para a loja, vocês pensam em colocar isso em prática agora ou estão mais na fase de conhecer?”

Respostas livres.

A IA classifica internamente como:

Quente: quer implementar agora / curto prazo
Morno: está avaliando
Frio: curiosidade / sem previsão

Não precisamos perguntar diretamente:

“Você está preparado para fechar?”

Acho agressivo demais para WhatsApp e tende a criar resistência antes da reunião.

2. Eu mudaria a regra de “todo lead agenda”

Hoje o prompt determina:

“Todo lead deve ser conduzido a uma tentativa de agendamento”

Eu substituiria por:

Todo lead com aderência comercial deve ser conduzido a uma tentativa de agendamento
Antes de oferecer horários, a IA deve verificar se há negócio compatível, dor relacionada à solução, capacidade mínima definida pela operação e intenção real de avaliar a Newave
Leads sem aderência ou claramente sem momento de compra não devem ocupar a agenda comercial, podendo permanecer em acompanhamento ou nutrição

Isso é essencial.

Senão podemos criar uma IA excelente em agendar reuniões ruins.

3. Decisor precisa entrar na regra de reunião

Eu acrescentaria ao prompt:

Participação de decisores

Se o contato disser que depende de sócio, gerente ou outro responsável para tomar a decisão, a IA deve tentar organizar a reunião com essa pessoa presente

Nunca diga que a reunião não pode acontecer sem ela

Explique o benefício de participar:

“Assim vocês conseguem avaliar juntos e tirar todas as dúvidas na mesma conversa”

Ao registrar o lead, informar ao comercial:

Decisor: sozinho / sócio / outro
Todos participarão: sim / não confirmado

Isso já prepara o Beto para a call.

4. O maior ajuste anti-no-show

No script atual, depois do agendamento a IA confirma e encerra.

Eu criaria um estado diferente:

AGENDADO
↓
CONFIRMAÇÃO SOLICITADA
↓
CONFIRMADO
↓
REUNIÃO

Após o agendamento:

“Fechado, ficou marcado pra amanhã às 14h pelo Google Meet

Como esse horário fica reservado pra sua operação, me confirma por aqui se posso contar contigo”

Agora existe uma ação ativa do lead.

Se responder:

“Sim”

CRM:

CONFIRMADO

Isso vale mais do que simplesmente enviar:

“Sua reunião é amanhã às 14h.”

5. Confirmação no dia

Quando o runtime disparar o lembrete, eu mudaria de lembrete passivo para confirmação:

“[Nome], passando pra confirmar nossa conversa de hoje às 14h, segue tudo certo por aí?”

Se responder sim:

CONFIRMADO NO DIA

Se não responder, entra numa rotina específica de recuperação.

Isso também está de acordo com a regra atual do documento de só disparar lembretes quando o CRM/runtime determinar.

6. Beto precisa receber um resumo melhor

# CONFIRMAÇÕES DE REUNIÃO — NEWAVE

## MOMENTO 1 — LOGO APÓS O AGENDAMENTO

### Variação 1

Fechado, ficou marcado pra hoje às 16h

Só me confirma se segue tudo certo pra gente se falar nesse horário?

### Variação 2

Combinado, nossa conversa ficou pra hoje às 16h

Me dá um ok por aqui só pra eu confirmar contigo

### Variação 3

Prontinho, deixei marcado pra hoje às 16h

Tá tudo certo pra você nesse horário?

---

# MOMENTO 2 — 1 A 2 HORAS ANTES

## SE O LEAD JÁ CONFIRMOU

### Variação 1

[Nome], passando só pra lembrar que nossa conversa é hoje às 16h

Nos falamos daqui a pouco

### Variação 2

[Nome], daqui a pouco temos nossa conversa das 16h

Até já

### Variação 3

[Nome], nossa conversa segue marcada pras 16h

Daqui a pouco nos falamos

---

## SE O LEAD AINDA NÃO CONFIRMOU

### Variação 1

[Nome], nossa conversa está marcada pra hoje às 16h

Segue tudo certo pra você?

### Variação 2

[Nome], passando pra confirmar nosso horário de hoje às 16h

Consegue me dar um ok por aqui?

### Variação 3

[Nome], temos nossa conversa marcada pras 16h de hoje

Posso manter esse horário contigo?

---

# MOMENTO 3 — 15 MINUTOS ANTES

## SE O LEAD JÁ CONFIRMOU

Não pedir confirmação novamente, apenas lembrar e facilitar a entrada na reunião

### Variação 1

[Nome], nossa conversa começa em 15 minutinhos

Até já

### Variação 2

[Nome], passando só pra avisar que daqui a 15 minutos começamos nossa conversa

Nos falamos já

### Variação 3

[Nome], falta só 15 minutinhos pra nossa conversa

Até daqui a pouco

---

## SE O LEAD AINDA NÃO RESPONDEU

Aqui fazemos a última tentativa de confirmação

### Variação 1

[Nome], nossa conversa começa em 15 minutos

Segue tudo certo pra você participar?

### Variação 2

[Nome], estamos a 15 minutos do nosso horário

Consegue me confirmar se vai conseguir entrar?

### Variação 3

[Nome], nossa conversa está marcada pra daqui a 15 minutos

Se aconteceu algum imprevisto, me avisa por aqui

