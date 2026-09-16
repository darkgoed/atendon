# Ativação do Instagram no AtendON

Este guia cobre **Instagram API with Instagram Login** (também chamado **Business Login for Instagram**) para contas Instagram Professional, Business ou Creator. Esse fluxo usa credenciais do Instagram, `graph.instagram.com` e **não exige vincular uma Página do Facebook**. Não selecione “Instagram API with Facebook Login”, “Facebook Login for Business” ou “Instagram Messaging via Messenger Platform”.[5]

> **Estado desta entrega:** o callback de desautorização está implementado e testado localmente com Fastify e PostgreSQL descartável. Não houve deploy, login Meta, App Review nem teste real do payload enviado pelo Dashboard. Sem Instagram App ID, App Secret, conta Professional de teste, autorização do titular e endpoint publicado, nenhuma compatibilidade live pode ser alegada.

## 1. O que depende de cada parte

### A equipe técnica precisa entregar antes da ativação

- release do AtendON com OAuth, callback, webhook, assinatura, tokens cifrados, refresh, desconexão, inbox, envio manual/IA, mídias e bloqueio da janela de 24 horas;
- variáveis Instagram propagadas para **`atendon-api` e `atendon-worker`**;
- as três rotas públicas técnicas abaixo funcionando no deploy de produção;
- uma solução aprovada pelo responsável jurídico para política de privacidade e exclusão de dados; o callback técnico de desautorização não substitui esse processo.

### O usuário/titular precisa fornecer ou executar

- conta Meta Developer e acesso administrativo ao Business Portfolio;
- conta Instagram Professional real de teste, pública durante o setup exigido pela Meta;
- Instagram App ID e Instagram App Secret;
- identidade jurídica, propriedade do domínio, e-mail comercial, ícone e categoria do app;
- política de privacidade e instruções/prazo/processo de exclusão aprovados pelo responsável jurídico;
- documentos e dados legítimos da empresa para Business Verification;
- autorização OAuth da conta Instagram e submissão do App Review.

A IA não deve inventar titular, CNPJ, razão social, endereço, contatos, política de privacidade, base legal, prazo de retenção ou declaração de propriedade. Também não se deve enviar segredo, token, senha, código de verificação ou credencial de revisor pelo chat.

## 2. URLs exatas de produção

O backend interno registra rotas sem o prefixo `/api`, mas o proxy público do AtendON publica a API sob `/api/`. Portanto, cadastre:

| Uso no Dashboard Meta | URL exata |
|---|---|
| OAuth Redirect URI | `https://atendon.alpdash.com.br/api/instagram/oauth/callback` |
| Webhooks Callback URL | `https://atendon.alpdash.com.br/api/webhooks/instagram` |
| Deauthorize callback URL | `https://atendon.alpdash.com.br/api/instagram/deauthorize` |
| Origem pública do painel | `https://atendon.alpdash.com.br` |

A Redirect URI deve coincidir **exatamente** com a URI usada no OAuth, inclusive esquema HTTPS, domínio, caminho e eventual barra final. A Meta recomenda conferir se o Dashboard acrescentou uma barra final.[3]

Não reutilize o OAuth callback nem o webhook como URL de política, exclusão de dados ou desautorização. Esses três fins têm contratos diferentes. O callback de desautorização acima apenas invalida a autorização e bloqueia envios futuros; a URL e o processo de exclusão de dados continuam separados conforme a seção 8.

## 3. Ordem segura de ativação

A ordem é obrigatória do ponto de vista operacional:

1. concluir e validar a implementação sem credenciais reais;
2. obter os dados jurídicos e de propriedade com o usuário;
3. criar/configurar o app Meta em modo Development;
4. inserir os segredos diretamente no Coolify;
5. fazer o deploy autorizado do release;
6. somente depois cadastrar/verificar callback de webhook e executar OAuth, pois os endpoints públicos só existem após o deploy;
7. testar com contas que tenham papel no app;
8. concluir Business Verification e App Review/Advanced Access;
9. mudar para Live e repetir o teste pós-aprovação.

O App Review exige que o aplicativo esteja acessível e testável externamente. A Meta orienta submeter apenas quando o desenvolvimento estiver concluído; um app inacessível ou incompleto pode ser rejeitado.[9]

## 4. Criar o app no Meta App Dashboard

### 4.1 Pré-requisitos

1. Acesse o [Meta App Dashboard](https://developers.facebook.com/apps/).
2. Entre com a conta real que administrará o app e aceite o cadastro como Meta Developer, se solicitado.
3. Garanta acesso de **Admin** ao Business Portfolio legítimo que será dono do app. Apenas um Admin do negócio pode concluir Business Verification.[14]
4. Confirme que a conta usada no teste é Instagram **Professional** — Business ou Creator.[5]

### 4.2 Criação

No App Dashboard:

1. Clique **Create App**.
2. Em use case, selecione **Other**.
3. Em app type, selecione **Business**.
4. Informe:
   - nome do aplicativo fornecido pelo titular;
   - e-mail comercial monitorado;
   - Business Portfolio correto, se já estiver disponível.
5. Finalize em **Create App**.

Esse é o fluxo oficial atual para criar um app com produto Instagram; a Meta exige app do tipo Business.[1]

### 4.3 Adicionar o produto correto

1. No Dashboard do app, localize **Instagram**.
2. Clique **Set up**.
3. Confirme que aparece **API setup with Instagram login**.
4. Não escolha a configuração com Facebook Login.
5. Em **Generate access tokens**, adicione a conta Instagram Professional de teste. A documentação de criação informa que essa conta deve ser pública e que outras contas podem ser adicionadas como testers.[1]

Para desenvolvimento com Standard Access, use apenas contas próprias/gerenciadas e pessoas com papel no app. Para clientes externos do AtendON, será necessário Advanced Access.[2][5]

## 5. Configurar o Business Login e as permissões

Em **Instagram → API setup with Instagram login → Set up Instagram business login**:

1. Clique **Set up**.
2. Em **Redirect URL**, cole exatamente:

   ```text
   https://atendon.alpdash.com.br/api/instagram/oauth/callback
   ```

3. Clique **Save**.
4. Abra **Business login settings**.
5. Confira em **OAuth Redirect URIs** a mesma URI, sem diferença de barra final.
6. Em **Deauthorize callback URL**, informe:

   ```text
   https://atendon.alpdash.com.br/api/instagram/deauthorize
   ```

7. Não use essa URL no campo **Data deletion request URL**. Esse campo exige a opção separada escolhida na seção 8.2.
8. Solicite somente estes scopes:

   ```text
   instagram_business_basic
   instagram_business_manage_messages
   ```

9. Não solicite `instagram_business_content_publish` nem `instagram_business_manage_comments` nesta ativação: o AtendON está sendo revisado para atendimento por DM, não publicação ou moderação.
10. Se o fluxo oferecer `enable_fb_login`, mantenha `false` para apresentar login do Instagram. A opção documentada `force_reauth=true` força a entrada novamente com credenciais Instagram e pode ser usada pelo fluxo de reautorização.[3]
11. Não monte manualmente uma URL OAuth com App Secret. O botão **Conectar Instagram** do AtendON deve iniciar o fluxo e validar um `state` de uso único.

A autorização devolve um código de uso único válido por uma hora. O backend o troca por token curto e depois por token longo de 60 dias; o App Secret só pode participar de chamadas server-side.[3]

### Permissões e recursos no Review

- `instagram_business_basic`: identificar a conta Professional conectada e seus dados básicos necessários à conexão.
- `instagram_business_manage_messages`: receber e enviar DMs para pessoas que iniciaram a conversa.
- **Human Agent:** o Dashboard pode adicioná-lo automaticamente quando `instagram_business_manage_messages` é solicitado.[1] O AtendON desta ativação deve continuar bloqueando mensagens após 24 horas e **não deve alegar uso da janela de sete dias** enquanto o recurso/tag `human_agent` não estiver implementado e revisado.

## 6. Configurar variáveis no Coolify sem expor segredos

### 6.1 Onde configurar

1. Entre diretamente no Coolify; não cole valores no chat, issue, e-mail ou documento.
2. Abra o projeto do AtendON → ambiente **production** → recurso **atendon** (`luaj67tqgrdsjlvdjrt9x3ot`).
3. Abra **Configuration → Environment Variables**.
4. Use **Normal view**, uma variável por vez. Isso permite controlar build/runtime e tratar valores sensíveis individualmente.[11]
5. Para todas as variáveis abaixo, deixe **Runtime Variable ligado** e **Build Variable desligado**. O Instagram App Secret e o verify token não são necessários durante o build; passá-los ao build aumenta exposição desnecessária.[11]
6. Se um valor contiver `$`, marque **Literal** para impedir interpolação.[11]

### 6.2 Valores

| Variável | Valor | Sensível? | API | Worker |
|---|---|---:|---:|---:|
| `INSTAGRAM_APP_ID` | Instagram App ID exibido em Business login settings | não é segredo, mas não publicar | sim | sim |
| `INSTAGRAM_APP_SECRET` | Instagram App Secret copiado do Dashboard | **sim** | sim | sim |
| `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | valor aleatório exclusivo gerado pelo operador | **sim** | sim | sim |
| `INSTAGRAM_REDIRECT_URI` | `https://atendon.alpdash.com.br/api/instagram/oauth/callback` | não | sim | sim |
| `INSTAGRAM_GRAPH_VERSION` | `v26.0` | não | sim | sim |
| `INSTAGRAM_MAX_CONNECTIONS` | `10` | não | sim | sim |
| `PANEL_PUBLIC_URL` | `https://atendon.alpdash.com.br` | não | sim | sim |

Regras:

- gere `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` no gerenciador de senhas ou terminal local do operador e cole diretamente no Coolify; não reutilize App Secret, JWT, senha ou token de outro webhook;
- nunca cole access token de usuário no Coolify: tokens das contas conectadas são obtidos por OAuth e armazenados cifrados pelo backend;
- não marque segredo como variável de build;
- não salve screenshot que revele valores;
- depois de salvar, confira somente os **nomes**, presença e escopo runtime; não abra nem copie os valores em logs.

O Compose é a fonte de verdade e precisa referenciar as variáveis para que o Coolify as injete nos serviços. Uma referência compartilhada no Compose fornece o mesmo valor a API e worker.[12] Se as variáveis não aparecerem ou um dos dois containers não as receber após o merge da implementação, **pare**: é bloqueio de release, não motivo para duplicar segredos manualmente em arquivos ou containers.

### 6.3 Deploy

Salvar variáveis não publica endpoints. Após aprovação explícita para release/deploy:

1. dispare o deploy normal do aplicativo AtendON pelo Coolify;
2. aguarde API, worker e painel ficarem saudáveis;
3. valide sem segredo que a configuração Instagram não lista variáveis ausentes;
4. valide que as URLs públicas respondem pelo release novo;
5. só então use **Verify and Save** no webhook da Meta e clique **Conectar Instagram**.

Não execute OAuth antes do deploy: a Meta redirecionará para uma rota inexistente/antiga. Não configure o webhook antes do deploy: o challenge GET falhará.

## 7. Webhooks: callback, campos e assinatura

Em **Instagram → API setup with Instagram login → Configure webhooks**:

1. Clique **Configure**.
2. Em **Callback URL**, informe:

   ```text
   https://atendon.alpdash.com.br/api/webhooks/instagram
   ```

3. Em **Verify token**, cole diretamente o mesmo valor de `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` salvo no Coolify.
4. Clique **Verify and Save**.
5. Em **Manage**, mantenha para a primeira ativação os campos:

   ```text
   messages
   messaging_seen
   message_reactions
   messaging_postbacks
   messaging_referral
   ```

6. Só adicione `messaging_optins`, `messaging_handover`, `standby`, comentários ou publicação quando houver uso implementado e permissão revisada.
7. Não selecione `message_echoes` nesta primeira ativação: a tabela oficial atual associa esse campo a `instagram_business_manage_comments`, o que conflita com o escopo mínimo de DM. O evento `messages` já é o contrato usado para tratar echoes; confirme qualquer mudança futura no Dashboard.[4]

O callback deve aceitar o challenge GET por HTTPS. Eventos POST vêm com `X-Hub-Signature-256`; o AtendON deve validar HMAC-SHA256 sobre o corpo bruto usando o App Secret antes de aceitar o JSON.[4]

Após cada OAuth bem-sucedido, o backend deve habilitar a conta conectada em `/<IG_ID>/subscribed_apps` com os campos suportados. Não execute essa chamada em `curl` com token na tela: o AtendON deve fazê-la server-side e registrar apenas sucesso/erro sanitizado. A resposta oficial de sucesso é `{"success":true}`.[4]

## 8. Privacidade, exclusão e desautorização

Esta seção distingue o que a documentação oficial afirma do que ainda precisa ser decidido. Ela **não é aconselhamento jurídico**.

### 8.1 Política de privacidade — obrigatória para App Review

O App Review de Instagram exige, em **Complete App Settings**, uma URL pública de política de privacidade, além de ícone, categoria e e-mail comercial.[2][8] A URL é apresentada às pessoas no consentimento Meta.[9]

Além disso, apps que acessam dados de usuários devem informar na política como o usuário solicita a exclusão dos dados.[6]

**Responsabilidade do usuário/titular:** fornecer texto e URL reais, publicamente acessíveis, coerentes com o funcionamento e validados por quem responde juridicamente pelo serviço. A equipe técnica pode publicar o material aprovado, mas não deve inventá-lo.

Não cadastrar placeholder, gerador de política, página 404, documento privado ou política de outra empresa.

### 8.2 Exclusão de dados — mecanismo obrigatório; callback técnico opcional

A documentação oficial afirma duas coisas:

1. todos os apps que acessam dados de usuário devem oferecer uma forma de pedir exclusão e explicar isso na política de privacidade;[6]
2. no App Dashboard, o desenvolvedor deve informar **uma URL de instruções de exclusão ou uma URL de callback**.[6]

Nas configurações básicas, a Meta descreve a URL de exclusão como um link para instruções explícitas e permite que ele aponte para a seção pertinente da própria política de privacidade.[7]

Portanto:

- **obrigatório:** haver um caminho verdadeiro de solicitação/exclusão e uma URL pública cadastrada;
- **opcional:** implementar o callback automatizado, se for escolhida a alternativa de URL pública com instruções;
- **obrigatório se optar pelo callback:** HTTPS, validar o `signed_request`, iniciar a exclusão e responder JSON com `url` de acompanhamento e `confirmation_code`.[6]

O guia oficial de criação do produto Instagram manda adicionar **Data deletion request URL** em Business login settings.[1] Porém, no material oficial consultado não foi encontrado um contrato de payload específico para Instagram Login; a página geral de callback usa terminologia e exemplos de Facebook/app-scoped ID. Por isso, não se deve copiar cegamente o exemplo de Facebook para produção sem validar o teste do Dashboard e o identificador recebido.

**Decisão pendente do titular + equipe principal:** escolher e publicar uma destas opções:

- **Opção A — instruções públicas:** URL estável explicando como solicitar exclusão, como comprovar a conta, quais dados entram no pedido, canal de contato e acompanhamento conforme política aprovada;
- **Opção B — callback automatizado:** endpoint HTTPS específico, contrato validado com a Meta, fila/auditoria de pedidos e página pública de status.

Até essa decisão, deixe o campo sem placeholder e não submeta o Review.

### 8.3 Deauthorize callback — implementação local; payload live ainda pendente

O roteiro oficial de **Instagram API with Instagram Login** manda preencher **Deauthorize callback URL** em Business login settings.[1] A página geral de `signed_request` documenta o envelope assinado: duas partes Base64URL separadas por ponto, assinatura HMAC com o App Secret sobre o segmento codificado do payload, `algorithm=HMAC-SHA256`, `issued_at` Unix e `user_id` string.[15] A página do produto Instagram não publica um exemplo próprio do payload de desautorização; por isso, a equivalência do `user_id` recebido com o `IG_ID` salvo pelo OAuth precisa ser confirmada no teste do Dashboard antes de declarar compatibilidade live.

Endpoint preparado para produção:

```text
POST https://atendon.alpdash.com.br/api/instagram/deauthorize
Content-Type: application/x-www-form-urlencoded

signed_request=<assinatura-base64url>.<payload-base64url>
```

Comportamento implementado:

- parser `application/x-www-form-urlencoded` isolado no plugin; não reutiliza sessão, OAuth callback, webhook JSON nem desconexão autenticada;
- HMAC-SHA256 validado em tempo constante sobre o segmento Base64URL original; formulário, Base64URL, algoritmo, `issued_at` e `user_id` são validados estritamente;
- somente `user_id` que coincida exatamente com `provider_account_id` de uma conexão Instagram criada pelo OAuth pode afetar estado;
- callback válido remove o token e sua expiração, marca reconexão obrigatória, rejeita apenas envios Instagram ainda pendentes e consome states OAuth pendentes da mesma conexão;
- histórico de conversas, mensagens, eventos processados e mídia não é apagado por esse callback;
- replay, conta desconhecida e callback anterior a uma reautorização mais nova recebem a mesma resposta genérica `{"ok":true}` sem identificador, username, tenant ou outro dado pessoal;
- assinatura ausente/malformada recebe resposta genérica de erro e não altera o banco.

Isso é **desautorização**, não pedido de exclusão de dados. Exclusão continua pelo mecanismo e pela política aprovados na seção 8.2; o callback não fabrica decisão de retenção nem apaga todo o histórico.

#### Roteiro de validação no Dashboard — pendente do usuário Meta

Execute somente depois do deploy autorizado e com conta Professional legítima adicionada ao app:

1. cadastre `https://atendon.alpdash.com.br/api/instagram/deauthorize` em **Business login settings → Deauthorize callback URL**;
2. conecte a conta de teste pelo OAuth do AtendON e confirme que o `IG_ID` esperado ficou associado à conexão correta;
3. remova/desautorize o app pela interface oficial do Instagram/Meta que o Dashboard indicar;
4. confirme no AtendON que a mesma conexão ficou desconectada, sem token, com reconexão obrigatória e sem novos envios;
5. confirme que conversas/mensagens históricas continuam presentes e que o fluxo de exclusão separado não foi disparado;
6. reautorize a conexão, repita um callback antigo somente em ambiente controlado e confirme que a credencial nova permanece válida;
7. registre apenas formato/campos e resultado mascarados. Não capture nem publique App Secret, assinatura completa, token, `user_id`, username ou tenant.

Até esse roteiro receber um payload real do Dashboard, registre o resultado como **implementação local conforme o contrato geral `signed_request`; compatibilidade live Instagram pendente**. Não invente endpoint externo da Meta, payload específico do produto ou aprovação.

Não use `POST /instagram/connections/:id/disconnect` como callback público: essa rota é autenticada e atende à ação do usuário dentro do AtendON. Também não aponte para o OAuth callback ou para `/webhooks/instagram`.

### 8.4 Propriedade, negócio e dados jurídicos

Para clientes externos, o app precisa estar ligado a um negócio verificado; até isso ocorrer, usuários de outros negócios não conseguem conceder permissões e os recursos ficam inativos.[14]

O Admin do Business Portfolio deve fornecer diretamente à Meta dados e documentos verdadeiros. A equipe/IA não deve:

- criar ou escolher CNPJ/razão social/endereço;
- afirmar titularidade do domínio ou marca;
- responder questionário de tratamento/compartilhamento/retenção sem validação do responsável;
- aceitar termos ou certificar respostas em nome da empresa.

O Review pode apresentar perguntas de data handling e data protection sobre finalidade, compartilhamento, exclusão e segurança.[8][9] As respostas devem descrever a operação real após o deploy.

## 9. Conectar a conta de teste

Somente depois do deploy e do webhook verificado:

1. Entre no AtendON com um usuário autorizado a gerenciar conexões.
2. Abra **Conexão**.
3. Clique **Conectar Instagram**.
4. Dê um nome reconhecível à conexão, sem dados sensíveis.
5. Na janela oficial do Instagram, entre com a conta Professional de teste.
6. Revise e conceda apenas `instagram_business_basic` e `instagram_business_manage_messages`.
7. Confirme o retorno para:

   ```text
   https://atendon.alpdash.com.br/conexao?instagram=connected
   ```

8. Confira no AtendON:
   - canal Instagram;
   - username/identificador esperado;
   - estado conectado;
   - expiração/saúde do token;
   - ausência de erro de assinatura ou assinatura de webhooks.

Se o usuário cancelar, o retorno deve ser sanitizado e não pode mostrar `code`, token, App Secret ou erro bruto da Meta.

## 10. Teste real controlado

Use duas contas legítimas:

- **Conta A:** Instagram Professional pública, adicionada como tester/role e conectada ao AtendON;
- **Conta B:** outra conta Instagram usada para iniciar a conversa.

Não use conta falsa; a Meta cita contas falsas como motivo de rejeição.[9] Não mostre senhas, tokens, códigos de verificação, dados pessoais desnecessários ou abas do Coolify na gravação.

### 10.1 Entrada e resposta manual

1. Na Conta B, envie para a Conta A: `TESTE META 01 - entrada manual`.
2. Confirme que aparece uma única conversa Instagram no inbox do AtendON.
3. Confira remetente, texto, horário e canal; o identificador não pode aparecer como telefone falso.
4. Responda pelo compositor: `TESTE META 01 - resposta manual`.
5. Na Conta B, confirme o recebimento uma única vez.
6. No AtendON, confirme que o echo não criou mensagem/conversa duplicada.
7. Envie nova mensagem pela Conta B e verifique o estado de leitura somente conforme o que a UI realmente suporta; não rotule echo como “entregue no aparelho”.

Uma conversa só pode começar depois que a pessoa envia mensagem à conta Professional; o app tem 24 horas para responder.[10]

### 10.2 Resposta por IA

1. Ative IA somente no workspace/conexão de teste, com um prompt controlado.
2. Na Conta B, envie: `TESTE META 02 - responda apenas CONFIRMADO`.
3. Confirme que o AtendON gera no máximo uma resposta e a envia pelo gateway Instagram, nunca pelo WhatsApp/Evolution.
4. Confira que o inbox mostra entrada e saída na mesma conversa.
5. Force handoff para humano e confirme que novas mensagens não geram resposta automática indevida.
6. Se a experiência for automatizada, use a transparência aprovada pelo responsável conforme lei aplicável; a Meta recomenda informar a pessoa de que interage com automação.[5][10]

### 10.3 Mídia

Teste um item por mensagem, usando arquivos sem dados pessoais:

| Caso | Arquivo de teste | Esperado |
|---|---|---|
| imagem inbound/outbound | PNG ou JPEG, até 8 MB | preview/download e envio único |
| áudio inbound/outbound | AAC, M4A, WAV ou MP4, até 25 MB | reprodução/download e envio único |
| vídeo inbound/outbound | MP4, OGG, AVI, MOV ou WebM, até 25 MB | reprodução/download e envio único |
| documento outbound | PDF, até 25 MB | download e envio único |

Esses formatos e máximos são os documentados atualmente pela Send API.[10] Não use sticker, edição, exclusão, reação, arquivo genérico ou outro formato para provar uma capacidade que o AtendON não exponha. Registre erro explícito para formato/tamanho não suportado; não mostre falso sucesso.

Para cada mídia:

1. envie da Conta B para a Conta A e confirme a entrada no AtendON;
2. envie pelo AtendON para a Conta B e confirme o recebimento;
3. confira que a URL pública temporária não contém token Meta;
4. confira que expiração/erro de download não vaza credenciais em tela ou log.

### 10.4 Janela de 24 horas e cold outbound

**Dentro da janela**

1. faça a Conta B enviar uma nova DM;
2. responda manualmente e por IA;
3. confirme sucesso e atualização do prazo na UI.

**Fora da janela — validação live**

1. use uma conversa real sem nova mensagem da pessoa por mais de 24 horas, ou aguarde esse período;
2. tente envio manual: o AtendON deve bloquear antes de chamar a Meta e explicar janela expirada;
3. tente gatilho de IA: não deve haver envio;
4. envie nova mensagem pela Conta B;
5. confirme que a janela reabre e uma resposta normal volta a funcionar.

Alterar relógio/banco ou mockar a Meta prova apenas teste controlado, não validação live. Não use `human_agent` para contornar esse caso. Também não tente iniciar conversa nova pela Conta A: cold outbound não faz parte do contrato.[10]

### 10.5 Resultado mínimo a registrar

- data/hora e contas de teste mascaradas;
- conexão/tenant corretos;
- manual, IA, imagem, áudio, vídeo e PDF: passou/falhou;
- dentro/fora da janela: passou/falhou;
- webhook inválido/replay/echo: sem duplicação ou vazamento;
- versão Graph testada;
- nenhuma captura contendo segredo.

## 11. Advanced Access, Business Verification e App Review

### 11.1 Quando é necessário

- **Standard Access:** suficiente apenas para conta própria/gerenciada e pessoas/contas adicionadas ao app durante desenvolvimento.
- **Advanced Access:** obrigatório para o AtendON atender contas Professional de clientes que a empresa não possui/gerencia. Exige App Review e Business Verification.[2][5]
- Webhooks do Instagram Login exigem app Live, Advanced Access e Business Verification segundo a tabela atual do produto.[4]

### 11.2 Preparação

1. Conecte o app ao Business Portfolio legítimo em **Settings → Basic → Verification**.
2. O Admin do negócio conclui Business Verification no Business Manager com dados/documentos reais.[14]
3. Em **Settings → Basic**, preencha:
   - ícone 1024×1024 que não use marca Meta;
   - Privacy Policy URL pública;
   - categoria correta;
   - e-mail comercial monitorado;
   - App Purpose: **Clients**, pois o AtendON atende outros negócios.[9]
4. Publique as URLs verdadeiras de exclusão e desautorização definidas na seção 8.
5. Garanta que app, login e fluxo estejam acessíveis aos revisores.
6. Faça pelo menos uma chamada bem-sucedida com cada permissão solicitada nos 30 dias anteriores à submissão.[9]
7. Em **Instagram → API setup with Instagram login → Complete app review**, clique **Continue to app review**.
8. Em **App Review → Requests**, clique **Edit**.
9. Solicite apenas:
   - `instagram_business_basic`;
   - `instagram_business_manage_messages`;
   - recurso automático Human Agent somente conforme o Dashboard exigir, sem declarar uso não implementado.
10. Forneça credenciais de revisor somente no campo seguro do App Review, nunca neste guia ou chat.

A Meta pode aprovar algumas permissões e rejeitar outras. Não há promessa de aprovação.[8]

### 11.3 Texto factual do use case

Adapte apenas nomes/URLs aprovados pelo titular:

> O AtendON permite que uma empresa conecte sua conta Instagram Professional por Instagram Login. Usamos `instagram_business_basic` para identificar e exibir a conta conectada. Usamos `instagram_business_manage_messages` para receber, organizar e responder mensagens iniciadas pelo usuário do Instagram em uma caixa de entrada de atendimento, com resposta manual ou automatizada e transferência para humano. O produto bloqueia novos envios fora da janela suportada e permite desconectar/reautorizar a conta.

Não acrescente publicação, comentários, insights, anúncios, cold outbound ou retenção que o produto não execute.

### 11.4 Roteiro do screencast

A Meta pede gravação end-to-end para cada permissão/recurso, com app e botão de login visíveis. Recomenda UI em inglês quando possível; se não, legendas/tooltips explicativos. A gravação deve ter 1080p ou mais, largura de tela de até 1440, cursor visível e **sem áudio**.[2][9]

Grave uma janela limpa, sem console, Coolify ou gerenciador de senhas:

1. **Abertura (5–10 s):** URL pública e nome do AtendON; legenda “Web application”.
2. **Login no AtendON:** use conta de revisor preparada; senha mascarada.
3. **Localizar a função:** abra **Conexão** e mostre claramente **Conectar Instagram**.
4. **Consentimento:** clique no botão, mostre a janela oficial Instagram e os dois scopes solicitados; não exponha senha.
5. **Retorno:** mostre a conexão como ativa, username e status — demonstra uso de `instagram_business_basic`.
6. **Inbound:** na Conta B, envie uma DM de texto para a Conta A; volte ao AtendON e mostre a conversa chegando.
7. **Manual outbound:** responda no inbox e mostre a mensagem recebida na Conta B.
8. **IA:** envie uma nova DM controlada e mostre uma única resposta automática, seguida do caminho de atendimento humano.
9. **Mídia:** mostre uma imagem chegando e, se o upload final estiver pronto, um arquivo suportado sendo enviado. Não tente cobrir formato não implementado.
10. **Janela:** mostre na UI a indicação de prazo/capacidade de envio. Para bloqueio fora da janela, use evidência real ou rotule claramente um ambiente de teste; não fabrique uma resposta da Meta.
11. **Desconexão/reautorização:** mostre os botões e a confirmação sem revelar token.
12. **Privacidade/exclusão:** abra as páginas públicas aprovadas.
13. **Encerramento:** legenda listando exatamente `instagram_business_basic` e `instagram_business_manage_messages`.

Se o formulário separar permissões, produza/associe uma gravação que mostre claramente cada uma. Não peça permissão/recurso sem screencast correspondente; a Meta afirma que ele não será aprovado.[9]

## 12. Reautorizar, desconectar e revogar

### 12.1 Reautorizar no AtendON

Use quando a UI mostrar token expirado, permissão revogada, escopo ausente ou “reconexão necessária”:

1. abra **Conexão**;
2. localize a conexão Instagram correta;
3. clique **Reautorizar**;
4. conclua o login na janela oficial Instagram;
5. conceda os dois scopes;
6. confirme retorno `?instagram=connected`, conta correta, nova expiração e webhook ativo;
7. envie uma nova DM da Conta B e repita o smoke de entrada/saída.

Não copie token antigo, não edite banco e não troque App Secret para corrigir autorização individual.

### 12.2 Desconectar no AtendON

1. abra **Conexão**;
2. clique **Desconectar** na conexão correta;
3. leia o impacto e confirme;
4. verifique estado desconectado, novos envios bloqueados e histórico preservado conforme a política aprovada.

A desconexão local deve eliminar tokens e impedir jobs futuros, mas não deve ser descrita como exclusão integral dos dados nem como revogação comprovada na Meta.

### 12.3 Revogar também no Instagram

No Instagram Web:

1. clique **More → Settings**;
2. em **Your app and media**, abra **Website permissions**;
3. clique **Apps and Websites → Active**;
4. clique **Remove** ao lado do app.

A própria ajuda do Instagram alerta que remover o app interrompe o acesso futuro a dados não públicos, mas não apaga automaticamente dados que o aplicativo já armazenou.[13] Para exclusão desses dados, siga o mecanismo publicado na política de privacidade.

Para conectar novamente depois de remover, volte ao AtendON e inicie **Conectar Instagram/Reautorizar**; uma nova autorização OAuth será necessária.

## 13. Checklist final de go-live

- [ ] release Instagram revisado e deploy autorizado concluído;
- [ ] API e worker saudáveis e com todas as variáveis runtime;
- [ ] nenhum segredo em Git, chat, log, screenshot ou build arg;
- [ ] Redirect URI exata cadastrada;
- [ ] webhook HTTPS verificado e campos mínimos selecionados;
- [ ] conta Professional de teste correta e pública quando exigido;
- [ ] OAuth conclui e assinatura da conta ocorre server-side;
- [ ] manual, IA, mídia e janela testados sem falsa alegação live;
- [ ] política de privacidade pública e aprovada pelo titular;
- [ ] mecanismo/URL de exclusão real definido;
- [ ] Deauthorize callback publicado na URL exata e payload real validado no Dashboard Meta;
- [ ] Business Portfolio e propriedade verificados pelo usuário;
- [ ] chamadas por permissão feitas nos 30 dias antes do Review;
- [ ] screencasts sem segredo e com legenda;
- [ ] Advanced Access aprovado antes de liberar clientes externos;
- [ ] app em Live somente após Review e repetição do teste pós-aprovação.

## Sources

[1] https://developers.facebook.com/documentation/instagram-platform/create-an-instagram-app — Create a Meta app for the Instagram API
[2] https://developers.facebook.com/documentation/instagram-platform/app-review.md — App Review for Instagram API
[3] https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login — Business Login for Instagram
[4] https://developers.facebook.com/documentation/instagram-platform/webhooks — Setup Webhooks Subscriptions
[5] https://developers.facebook.com/documentation/instagram-platform/overview — Instagram Platform overview
[6] https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback — Data Deletion Request Callback
[7] https://developers.facebook.com/documentation/development/create-an-app/app-dashboard/basic-settings — Basic Settings
[8] https://developers.facebook.com/documentation/resp-plat-initiatives/appreview/content — App Review content requirements
[9] https://developers.facebook.com/documentation/resp-plat-initiatives/appreview/tutorial — App Review submission guide
[10] https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api — Send Messages
[11] https://coolify.io/docs/knowledge-base/environment-variables — Coolify Environment Variables
[12] https://coolify.io/docs/knowledge-base/docker/compose — Coolify Docker Compose
[13] https://help.instagram.com/1144624522593085 — Instagram Help: Manage apps and websites
[14] https://developers.facebook.com/documentation/development/release/business-verification — Business Verification
[15] https://developers.facebook.com/docs/reference/login/signed-request/ — Fields in signed_request
