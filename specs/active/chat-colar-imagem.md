# SPEC: Conversas — colar imagem com CTRL+V entra no fluxo de anexo (upload → prévia → confirmar)
## Objective
Ao colar (CTRL+V) uma imagem copiada para o composer do chat, a imagem do clipboard deve
subir como anexo, exibir prévia e só ser enviada após confirmação do atendente (mesmo fluxo do
anexo por seleção) — nunca enviar direto no colar.
## Source
comments.md:226 — "Ao copiar uma imagem e for colar para enviar para um contato com CTRL + V a
imagem que esta no copia e cola, deve ser enviada, antes deve subir a imagem, ter a previa e
depois confirmar envio."
## Current State
- ConversationComposer (components/conversation-composer.tsx) já tem fluxo completo de anexo:
  selectFile (167-176) valida suporte do canal/limite/vazio; prévia de imagem (308-334); envio
  base64 com Idempotency-Key e legenda (224-269). Não há handler de paste.
- capabilities por canal: supports("image") (115) respeita channelCapabilities.
## Desired Behavior
Colar uma imagem (clipboard contendo files) no textarea, quando o canal suporta imagem:
1. O comportamento padrão do paste de texto NÃO é afetado (colar texto continua colando).
2. A imagem vira o attachment atual (substitui anexo anterior), passa por selectFile
   (validação de tipo/tamanho/suporte) e exibe a prévia com campo de legenda.
3. Envio só ocorre no submit (botão Enviar / Enter) — fluxo existente, nada novo.
4. Sem suporte (canal sem image, enviar desabilitado) → nada é interceptado ou erro informativo
   via onError existente ("Imagem não é suportada por este canal").
## Requirements
### R1 — Handler onPaste no textarea do composer
Acceptance Criteria:
- `onPaste` no Textarea (components/conversation-composer.tsx): itera `event.clipboardData?.files`;
  se existir arquivo de imagem (file.type.startsWith("image/")) E supports("image"): preventDefault
  + selectFile(file). Múltiplos arquivos: usa o primeiro e ignora o resto.
- Se o clipboard tem texto e arquivo, o arquivo vence (preventDefault) — sem duplicação de texto.
- Se não há arquivo de imagem: SEM preventDefault (colar texto normal funciona).
- Não intercepta quando recording (textarea disabled — sem evento) e respeita canSend/sending.
- Sem APIs novas de clipboard (event.clipboardData é coberto pelos alvos Safari 12+); nada de
  navigator.clipboard.
Verification:
- Novo teste apps/panel/tests/conversation-composer-paste.test.tsx:
  (a) paste de File("image/png") chama selectFile → prévia visível (alt "Prévia do anexo") e
  NENHUM POST dispara até submit;
  (b) paste de texto puro altera o draft;
  (c) paste de imagem com canal sem capability "image" → mensagem de erro via onError e sem anexo;
  (d) imagem > limite → erro de limite, sem anexo.
### R2 — Paridade com anexo por botão
Acceptance Criteria:
- O anexo colado usa exatamente o mesmo estado/caminho do anexo por seleção: legenda, remover
  (aria-label "Remover anexo"), validações e envio idempotente — nenhuma divergência de fluxo.
Verification:
- npx vitest run tests/conversation-composer-paste.test.tsx
  tests/conversation-composer-compat.test.tsx tests/conversation-composer-instagram.test.tsx —
  todos verdes; tsc limpo.
## Invariants
- Fluxo WhatsApp/Instagram existente intacto; idempotência do envio preservada.
- Nenhum envio automático no paste (pedido literal: confirmar depois da prévia).
## Edge Cases
- Paste de imagem durante attachment de áudio: impossível (textarea disabled) — coberto por teste
  de regressão existente.
- Clipboard com arquivo não-imagem (ex. pdf copiado do Finder): trata-se como arquivo genérico?
  NÃO — intercepta somente image/*; outros arquivos colados seguem o comportamento padrão do
  navegador (fora de escopo).
- Instagram sem capability image → erro informativo.
## Dependencies
- Nenhuma. Frontend only.
## Affected Areas
apps/panel/components/conversation-composer.tsx; apps/panel/tests/conversation-composer-paste.test.tsx (NOVO).
## Non-goals
- Não alterar upload/serviço de mídia do backend; não colar em outros composers (tripz-ai).
## Constraints
- Sem eslint-disable; usar onKeyDown/onPaste nativos do Textarea (componente ui já propaga).
## Required Tests
R1 (4 casos) + suítes de composer existentes.
## Definition of Done
- [ ] R1–R2 implementados; testes novos e existentes verdes; tsc/npm run build limpos.
