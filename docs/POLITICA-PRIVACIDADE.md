# Política de privacidade do AtendON — versão publicada

Este documento acompanha o texto publicado em `/privacidade`. A revisão jurídica permanece recomendável e é responsabilidade do responsável pelo tratamento; este material não substitui aconselhamento jurídico nem as políticas da Meta.

## Dados confirmados pelo responsável

- **Responsável:** Arthur de Almeida Brittes Muller Amorim
- **CNPJ:** 64.988.692/0001-00
- **Localização:** Guaratinguetá-SP
- **Canal de privacidade e exclusão:** arthurmuller07@gmail.com
- **Mecanismo de exclusão:** instruções públicas na política, por e-mail

Esses valores vivem em `apps/panel/app/privacidade/config.ts`. Não duplicar ou corrigir esses identificadores fora do bloco de constantes.

## Declarações que o texto preserva

- O AtendON pode operar atendimento, conversas, agenda, leads, mídia e registros técnicos conforme a configuração real.
- Empresas usuárias podem definir finalidades e meios para dados de seus próprios clientes; o papel jurídico de cada parte depende da operação e do contrato, e os avisos dessas empresas governam suas decisões como controladoras.
- As bases legais são apresentadas de modo condicional: podem incluir execução de contrato ou procedimentos relacionados, obrigação legal ou regulatória, legítimo interesse com salvaguardas e consentimento quando exigido.
- A integração Instagram Direct depende de autorização, permissões e regras vigentes da Meta.
- Revogação da autorização na Meta interrompe acesso futuro, mas não equivale a apagar dados já armazenados no AtendON.
- Não existe política geral automatizada de expurgo para conversas, mídias, leads e logs. A retenção é baseada na necessidade do serviço, obrigações legais, auditoria e segurança, com exclusão ou anonimização após pedido válido quando cabível, sujeita a preservações aplicáveis. O texto não promete duração fixa.
- Pedidos de exclusão devem usar o e-mail informado, com assunto sugerido, identificadores mínimos de conta/workspace/conversa e confirmação mínima de identidade. Não pedir senha, token ou dados excessivos.
- Fornecedores, compartilhamentos e transferências internacionais são descritos por categorias e de modo condicional; informações sobre um caso específico podem ser solicitadas pelo canal de privacidade.

## Fontes oficiais consultadas

- [LGPD — Lei nº 13.709/2018 (Planalto)](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm)
- [Meta — Data Deletion Request Callback](https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback)
- [Meta — Instagram API with Instagram Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login)
- [Meta — Instagram Platform overview](https://developers.facebook.com/documentation/instagram-platform/overview)
- [Meta — App Review content requirements](https://developers.facebook.com/documentation/resp-plat-initiatives/appreview/content)
- [Meta — Basic Settings](https://developers.facebook.com/documentation/development/create-an-app/app-dashboard/basic-settings)
- [Instagram Help — Manage apps and websites](https://help.instagram.com/1144624522593085)

## Checklist operacional

- Confirmar que o e-mail está monitorado e que o processo de resposta existe.
- Testar a página pública em HTTPS, sem login, incluindo a seção de exclusão.
- Confirmar no ambiente publicado que a URL canônica é `https://atendon.alpdash.com.br/privacidade`.
- Não declarar callback automatizado de exclusão: o mecanismo escolhido é instrução pública por e-mail.
- Revisar periodicamente se fornecedores, transferências internacionais e finalidades descritos correspondem à operação vigente.
