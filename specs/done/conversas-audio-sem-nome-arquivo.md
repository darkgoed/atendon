# SPEC: Conversas — áudio sem nome de arquivo

## Objective
Corrigir a exibição de mensagens de áudio em Conversas para que o usuário veja apenas o player de áudio (sem legenda, título ou nome de arquivo), preservando a exibição atual de nomes para documentos e o uso de conteúdo/caption em imagens.

## Source
comments.md

Item da linha 1: `Em conversas o audio nao deve ter o nome do arquivo, exemplo de erro: audio-2026-08-25T12-10-18-804Z`.

## Current State
- `apps/panel/components/conversation-composer.tsx:123-130` cria o arquivo da gravação com nome sintético `audio-${new Date().toISOString()...}.${extension}`. Esse nome é necessário hoje para enviar o blob ao backend, e é enviado em `fileName` em `:162-168`.
- `apps/backend/src/app.ts:2491-2497` decodifica a mídia e, quando o tipo é áudio, rejeita caption explícita. Porém define `text` como `mediaBody?.caption?.trim() || media.fileName`; portanto o nome sintético da gravação vira o `content` da mensagem.
- `apps/backend/src/app.ts:2523-2545` persiste `mediaFileName` e envia o mesmo nome ao WhatsApp. `apps/backend/src/modules/messages/repository.ts:1689-1699` grava `content`, `media_mime_type`, `media_file_name` e tamanho na tabela `messages`.
- `apps/backend/src/app.ts:1974-1988` retorna ao painel tanto `content` quanto `media_file_name`; `apps/panel/app/conversas/page.tsx:88-108` modela esses campos e encaminha a mensagem para `ConversationMessageMedia` (o arquivo contém a renderização da thread e a interface `Message`).
- `apps/panel/components/conversation-message-media.tsx:28-31` calcula `rawFileName` e aplica `audioDisplayName`; isso apenas remove a extensão, não o prefixo/data. Em `:43-49`, áudio renderiza `Microphone + fileName` como cabeçalho, `VoiceMessagePlayer` com `label={fileName}`, e pode renderizar `message.content` como parágrafo.
- `apps/panel/lib/audio-waveform.ts:11-16` confirma que `audioDisplayName("audio-2026-08-25T12-10-18-804Z.ogg")` produz ainda `audio-2026-08-25T12-10-18-804Z`; a função não é um filtro de nomes sintéticos.
- `apps/panel/components/conversation-composer.tsx:223-241` também mostra, enquanto o áudio está anexado antes do envio, player e nome do arquivo. Isso é a prévia do composer, não a mensagem já renderizada na conversa; o escopo desta SPEC é a exibição da mensagem na conversa.
- Para outros tipos, `apps/panel/components/conversation-message-media.tsx:53-73` usa o nome em fallback/alt da imagem e no card baixável do documento. `apps/panel/components/conversation-contact-panel.tsx:255-286` usa nomes de imagem/documento na aba de mídias; não deve ser alterado por esta correção.
- `apps/backend/src/modules/messages/outbound-media.ts:66-78` sanitiza e mantém o `fileName` recebido. Não há evidência de que o backend gere o nome `audio-...`; a origem é a gravação no composer, e a persistência como texto é o motivo de ele aparecer no histórico.

## Desired Behavior
Na thread de Conversas, toda mensagem com `media_type === "audio"` deve renderizar o player (`VoiceMessagePlayer`) sem cabeçalho com microfone/nome e sem parágrafo de caption/nome. O arquivo continua podendo ter `media_file_name` internamente para transporte, persistência ou download técnico, mas nunca deve ser apresentado como texto da mensagem de áudio. Imagens, documentos e stickers continuam com os comportamentos atuais.

## Requirements
### R1
Alterar a renderização de áudio em `apps/panel/components/conversation-message-media.tsx` para exibir o player sem nome/legenda visível.

Acceptance Criteria:
- Para `media_type: "audio"`, o DOM renderizado contém `VoiceMessagePlayer`/seu controle de reprodução e não contém `audioDisplayName`, `media_file_name`, `rawFileName`, `fileName`, `message.content` ou um cabeçalho textual derivado desses valores como texto visível.
- O player continua usando a URL autenticada construída por `apiMediaUrl(conversationId, message.id)`.
- Uma mensagem de áudio com `content === "audio-2026-08-25T12-10-18-804Z"` e qualquer `media_file_name` continua sem esse texto visível.

Verification:
- Adicionar/ajustar teste de componente ou teste de contrato textual em `apps/panel/tests/` e executar `npm test --workspace apps/panel` (ou o script equivalente definido em `package.json`).
- Inspeção de `apps/panel/components/conversation-message-media.tsx` confirma que o branch de áudio não renderiza o nome nem caption.

### R2
Preservar a exibição de mídia não-áudio.

Acceptance Criteria:
- Imagem continua renderizando `<img>` com link para a mídia e caption quando aplicável.
- Documento continua exibindo `media_file_name` (ou fallback `Documento`), MIME/tamanho e link de download.
- Sticker continua renderizando imagem sem ser convertido em card de documento ou player de áudio.

Verification:
- Executar os testes existentes de mídia, incluindo `apps/panel/tests/conversation-contact-panel.test.tsx`, e o teste novo/regressado para imagem, documento e áudio.
- Executar `npm run lint` e `npm run typecheck` na raiz.

### R3
Não alterar o contrato de envio nem a identificação técnica do arquivo.

Acceptance Criteria:
- `conversation-composer.tsx` continua enviando `mediaType`, `mimeType`, `fileName` e `dataBase64` para anexos.
- O backend continua aceitando/validando áudio pelo fluxo existente e persiste os metadados necessários; não é exigida migração ou alteração de `apps/backend/src/modules/messages/` para resolver a exibição.
- Áudio continua sem caption de usuário conforme a validação existente em `apps/backend/src/app.ts:2494-2495`.

Verification:
- Executar testes do backend relacionados a mensagens/mídia e `npm test` na raiz.
- Executar `npm run build` na raiz.

## Invariants
- URLs de mídia permanecem autenticadas e vinculadas à conversa/mensagem.
- Isolamento por tenant/permissões e endpoint de mídia não mudam.
- O nome original/sintético pode permanecer nos dados e no payload de transporte; apenas sua apresentação na thread é removida.
- Imagem, documento e sticker não herdam o branch/comportamento de áudio.

## Edge Cases
- Áudio recebido sem `media_file_name`, com nome vazio, com extensão desconhecida ou com nome sintético `audio-...` deve mostrar somente o player.
- Áudio com `content` vazio, igual ao filename ou diferente dele (inclusive texto legado) não deve mostrar parágrafo/caption na thread.
- Áudio anexado por upload e áudio gravado devem ter o mesmo comportamento após aparecerem na conversa.
- Mensagens de imagem/documento sem filename continuam usando os fallbacks existentes.

## Dependencies
- `VoiceMessagePlayer` em `apps/panel/components/ui/voice-input.tsx`.
- Contrato de mensagem consumido por `apps/panel/app/conversas/page.tsx`.
- Test runner/scripts do monorepo em `package.json`.

## Affected Areas
- Principal: `apps/panel/components/conversation-message-media.tsx`.
- Testes: `apps/panel/tests/` (novo ou ajuste de teste de renderização/contrato).
- Investigados, sem alteração necessária para esta correção: `apps/panel/components/conversation-composer.tsx`, `apps/panel/app/conversas/page.tsx`, `apps/backend/src/app.ts`, `apps/backend/src/modules/messages/outbound-media.ts`, `apps/backend/src/modules/messages/repository.ts`.

## Non-goals
- Não remover ou renomear arquivos de áudio no upload, banco ou WhatsApp.
- Não mudar a geração `audio-${timestamp}` usada como nome técnico do blob.
- Não mudar transcrição, download, endpoint de mídia, captions de imagens ou cards de documentos.
- Não alterar a aba de mídias do contato, follow-ups ou outros módulos.

## Constraints
- Implementar somente a camada de apresentação solicitada.
- Manter TypeScript/React e os padrões CSS existentes.
- Não introduzir lógica que esconda nomes de imagem/documento.
- Não aceitar caption de áudio como novo comportamento; a regra de backend permanece vigente.

## Required Tests
- Teste de `ConversationMessageMedia` para áudio com filename/título sintético verificando player presente e nome/caption ausentes.
- Testes de regressão para imagem, documento e sticker verificando seus nomes/captions atuais.
- `npm test`
- `npm run lint`
- `npm run typecheck`
- `npm run build`

## Definition of Done
- [ ] O branch de áudio em `conversation-message-media.tsx` mostra somente o player, sem nome, legenda ou texto de `content`.
- [ ] O caso `audio-2026-08-25T12-10-18-804Z` não aparece visualmente na conversa.
- [ ] Imagem, documento e sticker mantêm seus comportamentos atuais.
- [ ] Contrato de envio e metadados backend permanecem inalterados.
- [ ] Testes de áudio e regressão de mídia foram adicionados/ajustados e passam.
- [ ] `npm test`, `npm run lint`, `npm run typecheck` e `npm run build` passam.
