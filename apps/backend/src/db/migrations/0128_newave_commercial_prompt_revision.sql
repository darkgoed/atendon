-- Publica a revisão comercial do prompt da Newave pedida pelo sócio
-- (comments.md: qualificação curta com duas perguntas comerciais, regra de
-- aderência comercial, participação de decisores e confirmação anti no-show).
--
-- POR QUE UMA MIGRATION E NÃO UM UPDATE DIRETO
-- O runtime não lê agent_configs.system_prompt: ele lê a VERSÃO ATIVA
-- (repository.ts JOIN agent_config_versions v ON v.id=a.active_version_id).
-- Migrations antigas (0047, 0058) atualizaram só agent_configs e por isso não
-- chegaram ao modelo. Aqui seguimos o padrão correto, o mesmo de
-- db/provision-tripz.ts: aposentar a versão ativa, inserir uma versão nova e
-- reapontar active_version_id, mantendo o histórico imutável intacto
-- (trigger protect_agent_version_snapshot, migration 0057).
--
-- ESCOPO: exclusivamente o tenant slug 'newave-ia'. Meta Cell e Tripz não são
-- tocados. Se o tenant não existir (ambiente limpo/CI), a migration é no-op.
--
-- IDEMPOTÊNCIA: se a versão ativa já contiver o marcador desta revisão, nada
-- acontece. Reexecutar não cria versões duplicadas.
--
-- ROLLBACK: reativar a versão anterior e reapontar agent_configs --
--   UPDATE agent_config_versions SET status='active',retired_at=NULL
--     WHERE id='<id_da_versao_anterior>';
--   UPDATE agent_config_versions SET status='retired',retired_at=now()
--     WHERE id='<id_da_versao_nova>';
--   UPDATE agent_configs SET active_version_id='<id_da_versao_anterior>',
--     system_prompt=(SELECT system_prompt FROM agent_config_versions
--                    WHERE id='<id_da_versao_anterior>')
--     WHERE id='<id_do_agente>';

DO $$
DECLARE
  v_tenant_id UUID;
  v_agent_id UUID;
  v_agent_count INTEGER;
  v_current_prompt TEXT;
  v_next_version INTEGER;
  v_new_version_id UUID;
  v_new_prompt TEXT;
BEGIN
  SELECT id INTO v_tenant_id FROM tenants WHERE slug = 'newave-ia';
  IF v_tenant_id IS NULL THEN
    RAISE NOTICE 'Tenant newave-ia ausente; nada a publicar';
    RETURN;
  END IF;

  -- Seleção do agente: falha alto se houver ambiguidade. Publicar a revisão no
  -- agente errado é pior do que não publicar, porque passa despercebido — o
  -- deploy fica verde e a IA continua com o texto antigo.
  SELECT count(*) INTO v_agent_count FROM agent_configs WHERE tenant_id = v_tenant_id;
  IF v_agent_count > 1 THEN
    RAISE EXCEPTION 'Tenant newave-ia tem % agent_configs; a revisão comercial precisa de um alvo inequívoco', v_agent_count;
  END IF;

  SELECT a.id INTO v_agent_id
  FROM agent_configs a
  WHERE a.tenant_id = v_tenant_id
  LIMIT 1
  FOR UPDATE;

  IF v_agent_id IS NULL THEN
    RAISE NOTICE 'Agente da Newave ausente; nada a publicar';
    RETURN;
  END IF;

  SELECT v.system_prompt INTO v_current_prompt
  FROM agent_config_versions v
  JOIN agent_configs a ON a.active_version_id = v.id
  WHERE a.id = v_agent_id;

  -- Marcador desta revisão: a pergunta de momento de compra, que não existe em
  -- nenhuma versão anterior do prompt.
  IF v_current_prompt LIKE '%colocar isso em prática agora ou estão mais na fase de conhecer%' THEN
    RAISE NOTICE 'Revisão comercial já publicada na versão ativa; nada a fazer';
    RETURN;
  END IF;

  -- O texto integral vive em instrução-newave-ia.md, versionado no repositório.
  -- Aqui aplicamos apenas o bloco comercial revisado sobre a versão ativa, para
  -- que a migration não carregue 50 KB duplicados e não desfaça ajustes feitos
  -- no painel entre um deploy e outro.
  v_new_prompt := v_current_prompt || E'\n\n'
    || E'## 31. Revisão comercial da qualificação e da confirmação\n\n'
    || E'Esta seção prevalece sobre qualquer instrução anterior deste prompt quando houver conflito\n\n'
    || E'### Duas perguntas comerciais\n\n'
    || E'Depois que nome, negócio e dor estiverem claros, faça somente estas duas perguntas comerciais, uma por turno\n\n'
    || E'Pergunta 1, decisor: “Uma parceria como essa depende só de você ou mais alguém participa da decisão?”\n\n'
    || E'Se o contato disser que depende de sócio, gerente ou outro responsável, responda: “Nesse caso, o ideal é ele participar da conversa também, assim vocês conseguem avaliar tudo juntos e evitamos você ter que repassar a apresentação depois”\n\n'
    || E'Nesse caso, encerre o turno sem fazer outra pergunta\n\n'
    || E'Pergunta 2, momento: “Se a solução fizer sentido para a loja, vocês pensam em colocar isso em prática agora ou estão mais na fase de conhecer?”\n\n'
    || E'Aceite respostas livres e classifique internamente como Quente quando houver intenção de implementar agora ou no curto prazo, Morno quando estiver avaliando e Frio quando houver apenas curiosidade ou nenhuma previsão\n\n'
    || E'Nunca revele essa classificação ao contato\n\n'
    || E'Não pergunte “Você está preparado para fechar?” nem faça pergunta equivalente\n\n'
    || E'### Aderência comercial antes da agenda\n\n'
    || E'Todo lead com aderência comercial deve ser conduzido a uma tentativa de agendamento\n\n'
    || E'Antes de oferecer horários, verifique internamente se existe negócio compatível, dor relacionada à solução, capacidade mínima definida pela operação e intenção real de avaliar a Newave\n\n'
    || E'Lead sem aderência ou claramente sem momento de compra não deve ocupar a agenda comercial, podendo permanecer em acompanhamento ou nutrição\n\n'
    || E'A nota de estrelas continua sem poder descartar o contato: aderência é critério de conversa, nunca da nota interna\n\n'
    || E'### Participação de decisores\n\n'
    || E'Se o contato disser que depende de sócio, gerente ou outro responsável, tente organizar a reunião com essa pessoa presente\n\n'
    || E'Nunca diga que a reunião não pode acontecer sem ela\n\n'
    || E'Explique o benefício: “Assim vocês conseguem avaliar juntos e tirar todas as dúvidas na mesma conversa”\n\n'
    || E'Ao registrar o lead com `qualificar_lead`, informe ao comercial em `participacao_decisor` o formato “Decisor: sozinho|sócio|outro; Todos participarão: sim|não confirmado”, e em `momento_compra` a classificação interna quente, morno ou frio\n\n'
    || E'### Confirmação ativa depois do agendamento\n\n'
    || E'Depois que `agendar_reuniao` retornar sucesso, peça uma ação ativa do contato em vez de apenas anunciar o horário\n\n'
    || E'“Fechado, ficou marcado pra amanhã às 14h pelo Google Meet\n\n'
    || E'Como esse horário fica reservado pra sua operação, me confirma por aqui se posso contar contigo”\n\n'
    || E'A cadeia interna é AGENDADO, CONFIRMAÇÃO SOLICITADA, CONFIRMADO, REUNIÃO\n\n'
    || E'### Três momentos de confirmação\n\n'
    || E'Só envie quando o CRM ou o runtime acionar explicitamente o evento\n\n'
    || E'1. Momento 1, logo após o agendamento: peça confirmação ativa\n'
    || E'2. Momento 2, uma a duas horas antes: se já confirmou, apenas lembre; se não confirmou, peça confirmação com uma pergunta curta\n'
    || E'3. Momento 3, quinze minutos antes: se já confirmou, não peça confirmação de novo, apenas lembre e facilite a entrada; se não respondeu, faça a última tentativa e diga que pode avisar por aqui se houve imprevisto\n\n'
    || E'No dia, use uma mensagem como “[Nome], passando pra confirmar nossa conversa de hoje às 14h, segue tudo certo por aí?”\n\n'
    || E'Se responder afirmativamente, registre CONFIRMADO NO DIA. Se não responder, entre na rotina de recuperação definida pelo CRM ou runtime\n\n'
    || E'Quando mencionar a duração do encontro, diga somente de 20 a 40 minutos\n';

  SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_next_version
  FROM agent_config_versions
  WHERE agent_config_id = v_agent_id;

  UPDATE agent_config_versions
  SET status = 'retired', retired_at = now()
  WHERE agent_config_id = v_agent_id AND status = 'active';

  INSERT INTO agent_config_versions(
    tenant_id, agent_config_id, version_number, source, status,
    system_prompt, ai_model, model_params, enabled_tools,
    created_by_user_id, activated_at
  )
  SELECT v_tenant_id, v_agent_id, v_next_version, 'manual', 'active',
         v_new_prompt, a.ai_model, a.model_params, a.enabled_tools,
         NULL, now()
  FROM agent_configs a
  WHERE a.id = v_agent_id
  RETURNING id INTO v_new_version_id;

  UPDATE agent_configs
  SET system_prompt = v_new_prompt,
      active_version_id = v_new_version_id,
      updated_at = now()
  WHERE id = v_agent_id AND tenant_id = v_tenant_id;

  RAISE NOTICE 'Revisão comercial da Newave publicada na versão % (%)', v_next_version, v_new_version_id;
END $$;
