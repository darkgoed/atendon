-- Provisiona as linhas de billing_providers por (code, environment).
--
-- Sem isto a tela ROOT de Gateways fica inoperante: toda a camada de provedores
-- (saveEncryptedCredentials, updateCommercialConfig, disconnect, o OAuth do
-- Mercado Pago) faz apenas `UPDATE ... WHERE code=$1 AND environment=$2` e
-- aborta com "billing provider not found" quando a linha nao existe. Nenhuma
-- migration, seed, rota ou script jamais inseriu essas linhas.
--
-- As linhas nascem SEM credencial e com status NOT_CONFIGURED: elas apenas
-- criam o destino do UPDATE. Nao ha efeito financeiro, porque todo o caminho
-- de dinheiro (webhook-service, charges, reconciler) exige
-- environment='production' AND status='CONNECTED' AND enabled=true.
--
-- enabled=false: conectar credenciais nao pode, sozinho, colocar um gateway em
-- operacao. A habilitacao continua sendo um ato deliberado do ROOT.
--
-- Idempotente: ON CONFLICT DO NOTHING respeita a UNIQUE (code, environment) de
-- 0138 e preserva qualquer provedor ja configurado.
--
-- A homologacao (quem pode ser habilitado) NAO e decidida aqui: a coluna
-- `homologated` so passa a existir em 0142, que roda depois desta migration e
-- marca o Mercado Pago como homologado.
INSERT INTO billing_providers (code, name, enabled, environment, accepted_methods)
VALUES
  ('mercadopago', 'Mercado Pago', false, 'sandbox',    ARRAY['pix','credit_card','boleto']),
  ('mercadopago', 'Mercado Pago', false, 'production', ARRAY['pix','credit_card','boleto']),
  ('manual_pix',  'PIX Manual',   false, 'sandbox',    ARRAY['pix']),
  ('manual_pix',  'PIX Manual',   false, 'production', ARRAY['pix'])
ON CONFLICT (code, environment) DO NOTHING;
