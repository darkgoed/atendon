-- Tripz IA aceita documentos de escritório (Word, Excel, CSV, TXT) além de
-- imagens e PDF. O texto é extraído no backend e enviado à IA como dado.
-- Troca só as duas CHECKs de tipo; linhas existentes já satisfazem as novas.
ALTER TABLE tripz_ai_attachments DROP CONSTRAINT IF EXISTS tripz_ai_attachments_mime_type_check;
ALTER TABLE tripz_ai_attachments ADD CONSTRAINT tripz_ai_attachments_mime_type_check CHECK (mime_type IN (
  'image/jpeg','image/png','image/webp','application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain','text/csv'
));

ALTER TABLE tripz_ai_attachments DROP CONSTRAINT IF EXISTS tripz_ai_attachments_extension_check;
ALTER TABLE tripz_ai_attachments ADD CONSTRAINT tripz_ai_attachments_extension_check CHECK (extension IN (
  'jpg','png','webp','pdf','docx','xlsx','txt','csv'
));
