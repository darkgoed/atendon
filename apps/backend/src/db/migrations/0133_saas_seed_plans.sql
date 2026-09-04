-- Idempotent commercial plan seed; existing ROOT edits are preserved.
INSERT INTO plans(code,name,description,monthly_price_cents,is_internal,position)
VALUES ('BASIC','Básico','Plano básico',49700,false,1),('MEDIUM','Médio','Plano médio',89700,false,2),('PRO','Pro','Plano profissional',109700,false,3),('LEGACY_UNLIMITED','Legacy Unlimited','Compatibility plan',0,true,99)
ON CONFLICT (code) DO NOTHING;
WITH configs(code, enabled) AS (VALUES
 ('BASIC',ARRAY['CONVERSATIONS','LEADS','PIPELINE']),
 ('MEDIUM',ARRAY['CONVERSATIONS','LEADS','PIPELINE','CALENDAR','AI','AI_FOLLOWUP','ROLES_PERMISSIONS']),
 ('PRO',ARRAY['CONVERSATIONS','LEADS','PIPELINE','CALENDAR','AI','AI_FOLLOWUP','POST_SALES','MEET','AI_STICKERS','WEB_PUSH','BULK_OPERATIONS','ADVANCED_REPORTS','ROLES_PERMISSIONS','DASHBOARD_WIDGETS']),
 ('LEGACY_UNLIMITED',ARRAY['CONVERSATIONS','LEADS','PIPELINE','CALENDAR','AI','AI_FOLLOWUP','POST_SALES','MEET','AI_STICKERS','WEB_PUSH','BULK_OPERATIONS','ADVANCED_REPORTS','ROLES_PERMISSIONS','DASHBOARD_WIDGETS']))
INSERT INTO plan_features(plan_id,feature_key,enabled)
SELECT p.id,f.feature_key,(f.feature_key=ANY(c.enabled)) FROM plans p JOIN configs c ON c.code=p.code JOIN feature_catalog f ON NOT f.is_future
ON CONFLICT DO NOTHING;
WITH vals(code,max_users,max_whatsapp,max_pipelines,max_ai) AS (VALUES ('BASIC',3,1,1,0),('MEDIUM',8,2,3,10000),('PRO',20,5,10,40000),('LEGACY_UNLIMITED',NULL,NULL,NULL,NULL))
INSERT INTO plan_limits(plan_id,limit_key,limit_value)
SELECT p.id,l.limit_key,CASE l.limit_key WHEN 'MAX_USERS' THEN v.max_users WHEN 'MAX_WHATSAPP_CONNECTIONS' THEN v.max_whatsapp WHEN 'MAX_PIPELINES' THEN v.max_pipelines WHEN 'MAX_AI_INTERACTIONS' THEN v.max_ai ELSE NULL END
FROM plans p JOIN vals v ON v.code=p.code CROSS JOIN limit_catalog l
ON CONFLICT DO NOTHING;
