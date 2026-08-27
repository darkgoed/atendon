import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

export const PRIVILEGED_DATABASE_ENVIRONMENT_KEYS = [
  "MIGRATION_DATABASE_URL",
  "DATABASE_OWNER_ROLE",
  "POSTGRES_USER",
  "ATENDON_MIGRATION_DB_PASSWORD",
  "POSTGRES_PASSWORD",
  "ATENDON_OWNER_DB_ROLE",
  "ATENDON_MIGRATION_DB_USER",
  "ATENDON_RUNTIME_DB_USER",
  "ATENDON_RUNTIME_DB_PASSWORD",
  "TEST_DATABASE_URL"
] as const;

export function removePrivilegedDatabaseSecrets(
  environment: Record<string, string | undefined>
): void {
  for (const name of PRIVILEGED_DATABASE_ENVIRONMENT_KEYS) delete environment[name];
}

export function mergeRuntimeEnvironment(
  runtimeFileEnvironment: Record<string, string | undefined>,
  environment: Record<string, string | undefined>
): void {
  removePrivilegedDatabaseSecrets(runtimeFileEnvironment);
  for (const [name, value] of Object.entries(runtimeFileEnvironment)) {
    if (value !== undefined && environment[name] === undefined) environment[name] = value;
  }
  removePrivilegedDatabaseSecrets(environment);
}

// Parse the runtime file into an isolated object first. Infrastructure secrets
// are removed before any value is copied into the API/worker process.
const runtimeFileEnvironment: Record<string, string | undefined> = {};
loadEnv({
  path: fileURLToPath(new URL("../../../.env", import.meta.url)),
  processEnv: runtimeFileEnvironment,
  quiet: true
});
// ponytail: em test, .env.test já é a fonte curada (test-environment.ts); não reintroduzir
// segredos reais (ex.: OPENROUTER_MANAGEMENT_API_KEY) que .env.test deixou de fora de propósito.
if (process.env.NODE_ENV !== "test") {
  mergeRuntimeEnvironment(runtimeFileEnvironment, process.env);
}
const ephemeralSecret = () => randomBytes(32).toString("hex");
const developmentJwtSecret = ephemeralSecret();
const developmentDataEncryptionKey = process.env.JWT_SECRET ?? developmentJwtSecret;
const developmentMeetJwtSecret = ephemeralSecret();

const providerSlugSchema = z.string().trim().min(1).max(100)
  .transform((provider) => provider.toLocaleLowerCase("en-US"))
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/, "Use o slug do provedor exibido pela OpenRouter"));

const providerOrderSchema = z.array(providerSlugSchema).max(20)
  .superRefine((providers, context) => {
    if (new Set(providers).size !== providers.length) {
      context.addIssue({ code: "custom", message: "Não pode conter provedores duplicados" });
    }
  });

const postgresRoleSchema = z.string().trim().min(1).max(63)
  .regex(/^[a-z_][a-z0-9_$]*$/, "Use um identificador PostgreSQL simples e minúsculo");

const defaultSystemPrompt = `Você é a IA de atendimento da AtendON no WhatsApp. Atenda em português do Brasil, com tom cordial, claro e profissional.

Use as ferramentas de CRM/agendamento para conduzir o atendimento. Não invente categorias, parceiros, unidades, horários, links ou IDs: consulte sempre as ferramentas antes de mencionar ou usar qualquer opção.

Fluxo principal:
1. Ao abrir um atendimento de interesse, chame consultar_categorias() e consultar_unidades() antes de oferecer opções.
2. Depois de identificar nome, categoria e unidade, chame registrar_lead com status="em_atendimento". O telefone do contato já vem do sistema; nunca pergunte telefone.
3. Qualifique o lead avançando o status quando houver informação suficiente: em_atendimento = em conversa, aguardando_resposta = depende do contato, qualificado = pronto para agendar.
4. Se o caso pedir proposta/parceiro, chame consultar_parceiros(), escolha um parceiro retornado pela ferramenta e use enviar_proposta_parceiro(). Não invente parceiro nem link.
5. Se o contato quiser agendar, chame verificar_horarios() para a unidade e data desejadas, ofereça apenas horários retornados e confirme com agendar_visita() quando o cliente escolher.
6. Quando a qualificação estiver concluída, use atualizar_status_lead(status="qualificado").
7. Para reagendar ou cancelar visita, use reagendar_visita() ou cancelar_visita() conforme o pedido.
8. Pedidos explícitos do contato para falar com uma pessoa são tratados pelo sistema antes da geração. Não decida transferência e não produza marcador de handoff.

Regras de conversa:
- Peça apenas os dados que faltam para executar o próximo passo; não repita perguntas já respondidas.
- Nunca pergunte telefone.
- Antes de registrar ou atualizar categoria, unidade ou parceiro, use somente IDs retornados pelas ferramentas.
- Explique de forma simples o que foi feito somente depois que uma ferramenta confirmar a ação.
- Nunca confirme cadastro ou agendamento antes do retorno bem-sucedido da ferramenta correspondente.
- Se uma ferramenta retornar erro, tente corrigir os dados silenciosamente, não invente sucesso e continue com o próximo passo seguro. Não use dúvida, resposta incompleta, objeção, frustração, mudança de assunto ou falha de ferramenta como motivo para interromper a conversa. Nunca mencione erro técnico, sistema ou automação.`;

export function parseOpenRouterProviderOrder(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) return providerOrderSchema.parse(value);
  if (typeof value !== "string") return providerOrderSchema.parse(value);

  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("[")) {
    try {
      return providerOrderSchema.parse(JSON.parse(trimmed));
    } catch (error) {
      if (error instanceof z.ZodError) throw error;
      throw new Error("OPENROUTER_PROVIDER_ORDER deve ser uma lista JSON válida ou nomes separados por vírgula");
    }
  }
  return providerOrderSchema.parse(trimmed.split(",").map((provider) => provider.trim()));
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_VERSION: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().trim().min(1).optional()
  ),
  CHANGELOG_PATH: z.string().trim().min(1).default(fileURLToPath(new URL("../../../changelog.json", import.meta.url))),
  DEPLOY_VERSION: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().trim().min(1).max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "Use uma versão imutável, sem espaços")
      .default("development")
  ),
  CONTAINER_RUNTIME: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  PORT: z.coerce.number().int().positive().default(3110),
  HOST: z.string().ip().default("127.0.0.1"),
  DATABASE_URL: z.string().min(1),
  DATABASE_RUNTIME_ROLE: postgresRoleSchema.default("atendon_app"),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(10_000),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(30_000),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(60_000),
  DATABASE_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(15_000),
  DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(60_000),
  REDIS_URL: z.string().url().default("redis://localhost:6382"),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_APP_URL: z.string().url().default("http://localhost:3200"),
  OPENROUTER_APP_NAME: z.string().default("AtendON"),
  OPENROUTER_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  // Hard circuit breaker against runaway loops, not a normal termination path:
  // the operational/reserved split below (openrouter.ts) keeps ordinary
  // multi-tool-round turns from ever reaching this ceiling.
  AI_MAX_PROVIDER_REQUESTS_PER_TURN: z.coerce.number().int().min(1).max(20).default(14),
  // Slice of AI_MAX_PROVIDER_REQUESTS_PER_TURN held back for the forced final
  // answer (and its one reduced-prompt retry) once the operational budget for
  // tools/continuations/retries runs out. Never consumed by tool rounds.
  AI_RESERVED_FINAL_REQUESTS: z.coerce.number().int().min(0).max(19).default(2),
  AI_MAX_OUTPUT_TOKENS_PER_TURN: z.coerce.number().int().positive().default(8_192),
  AI_MAX_COST_USD_PER_TURN: z.coerce.number().positive().max(10).default(0.15),
  AI_HISTORY_MAX_MESSAGES: z.coerce.number().int().min(2).max(100).default(40),
  AI_HISTORY_MAX_CHARACTERS: z.coerce.number().int().min(1_000).max(100_000).default(12_000),
  AI_SCHEDULING_MIN_LEAD_MINUTES: z.coerce.number().int().min(1).max(240).default(15),
  OPENROUTER_TRANSCRIPTION_MODEL: z.string().min(1).default("openai/gpt-4o-mini-transcribe"),
  AUDIO_TRANSCRIPTION_MAX_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  OPENROUTER_PROVIDER_ORDER: z.preprocess(parseOpenRouterProviderOrder, providerOrderSchema.optional()),
  OPENROUTER_ALLOW_FALLBACKS: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  OPENROUTER_MANAGEMENT_API_KEY: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().min(16).optional()
  ),
  CHANGELOG_OPENROUTER_API_KEY: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().min(16).optional()
  ),
  CHANGELOG_OPENROUTER_MODEL: z.string().trim().min(1).default("google/gemma-4-26b-a4b-it:free"),
  DEFAULT_AI_MODEL: z.string().min(1).default("openai/gpt-oss-20b:free"),
  // Optional Tripz/Zulu-only configuration. An empty value keeps the feature
  // disabled/configuration-independent for tenants that do not use Tripz.
  TRIPZ_OFFERS_GROUP_LINK: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().trim().url().default("https://chat.whatsapp.com/F2XZvKQaToNFf6cDFYKPDL")
  ),
  TRIPZ_TENANT_SLUG: z.string().trim().min(1).default("tripzturismo-a44ab4"),
  DEFAULT_SYSTEM_PROMPT: z.string()
    .refine((value) => value.trim().length > 0, "DEFAULT_SYSTEM_PROMPT não pode conter somente espaços")
    .default(defaultSystemPrompt),
  AI_EVALUATOR_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  WHATSAPP_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  EVOLUTION_API_URL: z.string().url().default("http://localhost:8088"),
  EVOLUTION_API_KEY: z.string().min(16).default(ephemeralSecret()),
  EVOLUTION_WEBHOOK_URL: z.string().url().default("http://host.docker.internal:3110"),
  EVOLUTION_WEBHOOK_SECRET: z.string().min(24).default(ephemeralSecret()),
  EVOLUTION_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  JWT_SECRET: z.string().min(32).default(developmentJwtSecret),
  MEET_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  MEET_JWT_SECRET: z.string().min(32).default(developmentMeetJwtSecret),
  MEET_JWT_APP_ID: z.string().trim().min(1).max(128).default("atendon"),
  MEET_JWT_ACCEPTED_ISSUERS: z.string().trim().min(1).default("atendon"),
  MEET_JWT_ACCEPTED_AUDIENCES: z.string().trim().min(1).default("atendon"),
  MEET_PUBLIC_URL: z.string().url().default("http://localhost:8444"),
  MEET_RECORDINGS_DIR: z.string().trim().min(1)
    .default(fileURLToPath(new URL("../../../data/meet-recordings", import.meta.url))),
  MEET_RECORDING_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(30),
  DATA_ENCRYPTION_KEY: z.string().min(32).default(developmentDataEncryptionKey),
  DATA_ENCRYPTION_KEY_PREVIOUS: z.preprocess((value) => value === "" ? undefined : value, z.string().min(32).optional()),
  PANEL_ORIGIN: z.string().url().default("http://localhost:3200"),
  PANEL_PUBLIC_URL: z.string().url().default("http://localhost:3200"),
  WEB_PUSH_PUBLIC_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(40).max(200).optional()),
  WEB_PUSH_PRIVATE_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(20).max(200).optional()),
  WEB_PUSH_SUBJECT: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().trim().max(500).regex(/^(?:mailto:.+@.+|https:\/\/[^\s]+)$/i, "Use mailto:email ou uma URL HTTPS").optional()
  ),
  SMTP_HOST: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).optional()),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  SMTP_USER: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).optional()),
  SMTP_PASSWORD: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional()),
  SMTP_FROM: z.preprocess((value) => value === "" ? undefined : value, z.string().email().optional()),
  TRANSFER_NOTIFICATION_WEBHOOK_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  TRANSFER_NOTIFICATION_CHANNEL: z.enum(["webhook", "slack", "email", "whatsapp"]).default("webhook"),
  TRANSFER_NOTIFICATION_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(15_000),
  GOOGLE_MEET_TOKEN_URL: z.string().url().default("https://oauth2.googleapis.com/token"),
  GOOGLE_MEET_API_BASE_URL: z.string().url().default("https://meet.googleapis.com"),
  GOOGLE_MEET_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(15_000),
  GOOGLE_MEET_OAUTH_CLIENT_ID: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).optional()),
  GOOGLE_MEET_OAUTH_CLIENT_SECRET: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).optional()),
  GOOGLE_MEET_OAUTH_REDIRECT_URI: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  GOOGLE_MEET_OAUTH_AUTH_URL: z.string().url().default("https://accounts.google.com/o/oauth2/v2/auth"),
  GOOGLE_MEET_OAUTH_USERINFO_URL: z.string().url().default("https://openidconnect.googleapis.com/v1/userinfo"),
  PANEL_SEED_EMAIL: z.string().email().default("admin@atendon.local"),
  PANEL_SEED_PASSWORD: z.string().min(8),
  ROOT_SEED_EMAIL: z.preprocess((value) => value === "" ? undefined : value, z.string().email().optional()),
  ROOT_SEED_PASSWORD: z.preprocess((value) => value === "" ? undefined : value, z.string().min(12).optional())
});

export type AppConfig = z.infer<typeof schema>;
type ConfigEnvironment = Record<string, string | undefined>;

const isLoopbackHostname = (hostname: string) => ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(hostname);
const isKnownPlaceholder = (value: string) => {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  return normalized === "change-me-now"
    || normalized === "atendon"
    || normalized.startsWith("change-this-")
    || normalized.startsWith("replace-me-")
    || normalized.includes("placeholder");
};

function validateConfig(value: AppConfig, context: z.RefinementCtx, environment: ConfigEnvironment) {
  if (value.AI_RESERVED_FINAL_REQUESTS >= value.AI_MAX_PROVIDER_REQUESTS_PER_TURN) {
    context.addIssue({
      code: "custom",
      path: ["AI_RESERVED_FINAL_REQUESTS"],
      message: "AI_RESERVED_FINAL_REQUESTS deve ser menor que AI_MAX_PROVIDER_REQUESTS_PER_TURN"
    });
  }
  if ((value.ROOT_SEED_EMAIL && !value.ROOT_SEED_PASSWORD) || (!value.ROOT_SEED_EMAIL && value.ROOT_SEED_PASSWORD)) {
    context.addIssue({ code: "custom", path: ["ROOT_SEED_EMAIL"], message: "ROOT_SEED_EMAIL e ROOT_SEED_PASSWORD devem ser configurados juntos" });
  }
  if (value.SMTP_HOST && !value.SMTP_FROM) {
    context.addIssue({ code: "custom", path: ["SMTP_FROM"], message: "SMTP_FROM é obrigatório quando SMTP_HOST está configurado" });
  }
  if ((value.SMTP_USER && !value.SMTP_PASSWORD) || (!value.SMTP_USER && value.SMTP_PASSWORD)) {
    context.addIssue({ code: "custom", path: ["SMTP_USER"], message: "SMTP_USER e SMTP_PASSWORD devem ser configurados juntos" });
  }
  if (value.HOST === "0.0.0.0" && !value.CONTAINER_RUNTIME) {
    context.addIssue({
      code: "custom",
      path: ["HOST"],
      message: "HOST=0.0.0.0 exige CONTAINER_RUNTIME=true explícito"
    });
  }
  const webPushValues = [value.WEB_PUSH_PUBLIC_KEY, value.WEB_PUSH_PRIVATE_KEY, value.WEB_PUSH_SUBJECT];
  if (webPushValues.some(Boolean) && !webPushValues.every(Boolean)) {
    context.addIssue({ code: "custom", path: ["WEB_PUSH_PUBLIC_KEY"], message: "Configure juntos WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY e WEB_PUSH_SUBJECT" });
  }
  const meetOAuthValues = [value.GOOGLE_MEET_OAUTH_CLIENT_ID, value.GOOGLE_MEET_OAUTH_CLIENT_SECRET, value.GOOGLE_MEET_OAUTH_REDIRECT_URI];
  if (meetOAuthValues.some(Boolean) && !meetOAuthValues.every(Boolean)) {
    context.addIssue({ code: "custom", path: ["GOOGLE_MEET_OAUTH_CLIENT_ID"], message: "Configure juntos GOOGLE_MEET_OAUTH_CLIENT_ID, GOOGLE_MEET_OAUTH_CLIENT_SECRET e GOOGLE_MEET_OAUTH_REDIRECT_URI" });
  }
  if (value.NODE_ENV === "production") {
    if (
      !environment.DEPLOY_VERSION
      || ["development", "latest", "unknown"].includes(value.DEPLOY_VERSION.toLocaleLowerCase("en-US"))
      || isKnownPlaceholder(value.DEPLOY_VERSION)
    ) {
      context.addIssue({
        code: "custom",
        path: ["DEPLOY_VERSION"],
        message: "DEPLOY_VERSION imutável é obrigatória em produção"
      });
    }
    const safeProductionBind = ["127.0.0.1", "::1"].includes(value.HOST)
      || (value.HOST === "0.0.0.0" && value.CONTAINER_RUNTIME);
    if (!safeProductionBind) {
      context.addIssue({
        code: "custom",
        path: ["HOST"],
        message: "HOST deve usar loopback em produção ou 0.0.0.0 com CONTAINER_RUNTIME=true"
      });
    }
    for (const name of ["JWT_SECRET", "DATA_ENCRYPTION_KEY", "PANEL_SEED_PASSWORD"] as const) {
      if (!environment[name]) context.addIssue({ code: "custom", path: [name], message: "Obrigatória em produção; não há credencial padrão" });
      else if (isKnownPlaceholder(value[name])) context.addIssue({ code: "custom", path: [name], message: "Substitua a credencial de exemplo antes de iniciar em produção" });
    }

    if (value.MEET_ENABLED) {
      if (!environment.MEET_JWT_SECRET) {
        context.addIssue({ code: "custom", path: ["MEET_JWT_SECRET"], message: "Obrigatória em produção com o AtendON Meet habilitado" });
      } else if (isKnownPlaceholder(value.MEET_JWT_SECRET)) {
        context.addIssue({ code: "custom", path: ["MEET_JWT_SECRET"], message: "Substitua a credencial de exemplo antes de habilitar o AtendON Meet" });
      }
      for (const [name, accepted] of [
        ["MEET_JWT_ACCEPTED_ISSUERS", value.MEET_JWT_ACCEPTED_ISSUERS],
        ["MEET_JWT_ACCEPTED_AUDIENCES", value.MEET_JWT_ACCEPTED_AUDIENCES]
      ] as const) {
        const values = accepted.split(",").map((item) => item.trim()).filter(Boolean);
        if (!values.includes(value.MEET_JWT_APP_ID)) {
          context.addIssue({ code: "custom", path: [name], message: `${name} deve incluir MEET_JWT_APP_ID` });
        }
      }
    }

    const dedicatedSecrets = [
      value.JWT_SECRET,
      value.DATA_ENCRYPTION_KEY,
      ...(value.MEET_ENABLED ? [value.MEET_JWT_SECRET] : [])
    ];
    if (new Set(dedicatedSecrets).size !== dedicatedSecrets.length) {
      context.addIssue({ code: "custom", path: ["MEET_JWT_SECRET"], message: "JWT de sessão, JWT do Meet, criptografia de dados e API devem usar credenciais independentes" });
    }
    if (value.DATA_ENCRYPTION_KEY_PREVIOUS === value.DATA_ENCRYPTION_KEY) {
      context.addIssue({ code: "custom", path: ["DATA_ENCRYPTION_KEY_PREVIOUS"], message: "A chave anterior deve ser diferente da chave de dados atual" });
    }
    for (const name of ["PANEL_SEED_PASSWORD", "ROOT_SEED_PASSWORD"] as const) {
      const password = value[name];
      if (password && (password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password))) {
        context.addIssue({ code: "custom", path: [name], message: "A senha inicial deve ter ao menos 12 caracteres, com maiúscula, minúscula e número" });
      }
      if (password && isKnownPlaceholder(password)) {
        context.addIssue({ code: "custom", path: [name], message: "Substitua a senha de exemplo antes de iniciar em produção" });
      }
    }

    try {
      const databaseUrl = new URL(value.DATABASE_URL);
      const databasePassword = decodeURIComponent(databaseUrl.password);
      if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
        context.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "DATABASE_URL deve usar o protocolo PostgreSQL" });
      } else if (databasePassword && isKnownPlaceholder(databasePassword)) {
        context.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "DATABASE_URL usa a senha pública de exemplo" });
      } else if (decodeURIComponent(databaseUrl.username) !== value.DATABASE_RUNTIME_ROLE) {
        context.addIssue({
          code: "custom",
          path: ["DATABASE_URL"],
          message: "DATABASE_URL deve autenticar exatamente com DATABASE_RUNTIME_ROLE em produção"
        });
      }
    } catch {
      context.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "DATABASE_URL deve ser uma URL PostgreSQL válida" });
    }

    const panelPublicUrl = new URL(value.PANEL_PUBLIC_URL);
    if (!environment.PANEL_PUBLIC_URL || isLoopbackHostname(panelPublicUrl.hostname)) {
      context.addIssue({ code: "custom", path: ["PANEL_PUBLIC_URL"], message: "PANEL_PUBLIC_URL público é obrigatório em produção para links de convite" });
    }
    if (panelPublicUrl.protocol !== "https:") {
      context.addIssue({ code: "custom", path: ["PANEL_PUBLIC_URL"], message: "PANEL_PUBLIC_URL deve usar HTTPS em produção" });
    }

    const panelOrigin = new URL(value.PANEL_ORIGIN);
    if (!environment.PANEL_ORIGIN || isLoopbackHostname(panelOrigin.hostname) || panelOrigin.protocol !== "https:") {
      context.addIssue({ code: "custom", path: ["PANEL_ORIGIN"], message: "PANEL_ORIGIN público com HTTPS é obrigatório em produção" });
    } else if (value.PANEL_ORIGIN !== panelOrigin.origin) {
      context.addIssue({ code: "custom", path: ["PANEL_ORIGIN"], message: "PANEL_ORIGIN deve conter somente a origem, sem caminho ou barra final" });
    } else if (panelOrigin.origin !== panelPublicUrl.origin) {
      context.addIssue({ code: "custom", path: ["PANEL_ORIGIN"], message: "PANEL_ORIGIN e PANEL_PUBLIC_URL devem usar a mesma origem" });
    }

    if (value.MEET_ENABLED) {
      const meetPublicUrl = new URL(value.MEET_PUBLIC_URL);
      if (!environment.MEET_PUBLIC_URL || meetPublicUrl.protocol !== "https:" || isLoopbackHostname(meetPublicUrl.hostname)) {
        context.addIssue({ code: "custom", path: ["MEET_PUBLIC_URL"], message: "MEET_PUBLIC_URL público com HTTPS é obrigatório em produção com o AtendON Meet habilitado" });
      } else if (value.MEET_PUBLIC_URL !== meetPublicUrl.origin) {
        context.addIssue({ code: "custom", path: ["MEET_PUBLIC_URL"], message: "MEET_PUBLIC_URL deve conter somente a origem, sem caminho ou barra final" });
      }
    }

    if (value.WHATSAPP_ENABLED) {
      for (const name of ["EVOLUTION_API_KEY", "EVOLUTION_WEBHOOK_SECRET"] as const) {
        if (!environment[name]) context.addIssue({ code: "custom", path: [name], message: "Obrigatória em produção com WhatsApp habilitado" });
        else if (value[name].length < 32 || isKnownPlaceholder(value[name])) {
          context.addIssue({ code: "custom", path: [name], message: "Use uma credencial aleatória com ao menos 32 caracteres em produção" });
        }
      }
    }

    for (const [name, secret] of [
      ["DATA_ENCRYPTION_KEY_PREVIOUS", value.DATA_ENCRYPTION_KEY_PREVIOUS],
      ["SMTP_PASSWORD", value.SMTP_PASSWORD],
      ["GOOGLE_MEET_OAUTH_CLIENT_SECRET", value.GOOGLE_MEET_OAUTH_CLIENT_SECRET]
    ] as const) {
      if (secret && isKnownPlaceholder(secret)) {
        context.addIssue({ code: "custom", path: [name], message: "Substitua a credencial de exemplo antes de iniciar em produção" });
      }
    }

    if (value.GOOGLE_MEET_OAUTH_REDIRECT_URI) {
      const redirectUrl = new URL(value.GOOGLE_MEET_OAUTH_REDIRECT_URI);
      if (redirectUrl.protocol !== "https:" || isLoopbackHostname(redirectUrl.hostname)) {
        context.addIssue({ code: "custom", path: ["GOOGLE_MEET_OAUTH_REDIRECT_URI"], message: "A URI de callback do Google Meet deve ser pública e usar HTTPS em produção" });
      } else if (redirectUrl.origin !== panelPublicUrl.origin) {
        context.addIssue({ code: "custom", path: ["GOOGLE_MEET_OAUTH_REDIRECT_URI"], message: "A URI de callback do Google Meet deve usar a origem pública do painel" });
      }
    }
  }
}

export function parseAppConfig(environment: ConfigEnvironment): AppConfig {
  return schema.superRefine((value, context) => validateConfig(value, context, environment)).parse(environment);
}

export const config = parseAppConfig(process.env);
