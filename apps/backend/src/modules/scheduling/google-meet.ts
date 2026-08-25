import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { SignJWT, jwtVerify } from "jose";
import type { AppConfig } from "../../config.js";
import { config } from "../../config.js";

export const GOOGLE_MEET_CREATE_SCOPE = "https://www.googleapis.com/auth/meetings.space.created";
export const GOOGLE_MEET_SETTINGS_SCOPE = "https://www.googleapis.com/auth/meetings.space.settings";
export const GOOGLE_IDENTITY_SCOPES = ["openid", "email", GOOGLE_MEET_CREATE_SCOPE, GOOGLE_MEET_SETTINGS_SCOPE] as const;
const oauthStateSchema = z.object({ tenantId: z.string().uuid(), userId: z.string().uuid() });

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().default(3600),
  token_type: z.string().default("Bearer")
});

const userInfoSchema = z.object({ email: z.string().email(), email_verified: z.boolean().optional() });
const spaceResponseSchema = z.object({
  name: z.string().min(1),
  meetingUri: z.string().url().refine((value) => value.startsWith("https://meet.google.com/"), "URL de reunião inválido"),
  meetingCode: z.string().min(1)
});

export type GoogleMeetSpace = z.infer<typeof spaceResponseSchema>;

type GoogleMeetRuntimeConfig = Pick<AppConfig,
  | "GOOGLE_MEET_TOKEN_URL"
  | "GOOGLE_MEET_API_BASE_URL"
  | "GOOGLE_MEET_TIMEOUT_MS"
> & {
  oauthClientId?: string;
  oauthClientSecret?: string;
  refreshToken?: string;
};

export type GoogleMeetCredentials = {
  oauthClientId: string;
  oauthClientSecret: string;
  refreshToken: string;
};

export type GoogleMeetOAuthConfig = Pick<AppConfig,
  | "GOOGLE_MEET_TOKEN_URL"
  | "GOOGLE_MEET_TIMEOUT_MS"
  | "GOOGLE_MEET_OAUTH_AUTH_URL"
  | "GOOGLE_MEET_OAUTH_USERINFO_URL"
  | "GOOGLE_MEET_OAUTH_CLIENT_ID"
  | "GOOGLE_MEET_OAUTH_CLIENT_SECRET"
  | "GOOGLE_MEET_OAUTH_REDIRECT_URI"
>;

type CachedToken = { value: string; expiresAt: number };

export class GoogleMeetConfigurationError extends Error {
  readonly statusCode = 503;
  constructor(message = "A conexão OAuth com o Google Meet não está configurada") {
    super(message);
    this.name = "GoogleMeetConfigurationError";
  }
}

export class GoogleMeetApiError extends Error {
  readonly statusCode = 502;
  constructor(
    message: string,
    readonly outcome: "safe_to_retry" | "failed" | "uncertain" = "safe_to_retry",
    readonly phase: "oauth" | "space_create" = "oauth"
  ) {
    super(message);
    this.name = "GoogleMeetApiError";
  }
}

export type PreparedGoogleMeetCreate = {
  createSpace(): Promise<GoogleMeetSpace>;
};

export class GoogleMeetClient {
  private cachedToken?: CachedToken;

  constructor(
    private readonly cfg: GoogleMeetRuntimeConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {}

  isConfigured(): boolean {
    return Boolean(this.cfg.oauthClientId?.trim() && this.cfg.oauthClientSecret?.trim() && this.cfg.refreshToken?.trim());
  }

  private async accessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt - 60_000 > this.now()) return this.cachedToken.value;
    const clientId = this.cfg.oauthClientId?.trim();
    const clientSecret = this.cfg.oauthClientSecret?.trim();
    const refreshToken = this.cfg.refreshToken?.trim();
    if (!clientId || !clientSecret || !refreshToken) throw new GoogleMeetConfigurationError();

    let response: Response;
    try {
      response = await this.fetcher(this.cfg.GOOGLE_MEET_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken
        }),
        signal: AbortSignal.timeout(this.cfg.GOOGLE_MEET_TIMEOUT_MS)
      });
    } catch {
      throw new GoogleMeetApiError("Não foi possível renovar o acesso ao Google Meet");
    }
    if (!response.ok) throw new GoogleMeetApiError(`O Google recusou a renovação do acesso ao Meet (HTTP ${response.status})`);

    let token: z.infer<typeof tokenResponseSchema>;
    try {
      token = tokenResponseSchema.parse(await response.json());
    } catch {
      throw new GoogleMeetApiError("O Google retornou uma autenticação inválida para o Meet");
    }
    this.cachedToken = { value: token.access_token, expiresAt: this.now() + token.expires_in * 1000 };
    return token.access_token;
  }

  async prepareCreateSpace(): Promise<PreparedGoogleMeetCreate> {
    const accessToken = await this.accessToken();
    return {
      createSpace: () => this.createSpaceWithAccessToken(accessToken)
    };
  }

  private async createSpaceWithAccessToken(accessToken: string): Promise<GoogleMeetSpace> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.cfg.GOOGLE_MEET_API_BASE_URL.replace(/\/$/, "")}/v2/spaces`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        // ponytail: link é único por agendamento (nunca reutilizado/público), então liberar entrada
        // automática (accessType OPEN) substitui a sala de espera sem abrir risco de acesso indevido.
        body: JSON.stringify({ config: { accessType: "OPEN" } }),
        signal: AbortSignal.timeout(this.cfg.GOOGLE_MEET_TIMEOUT_MS)
      });
    } catch {
      throw new GoogleMeetApiError(
        "Não foi possível determinar se o Google Meet criou a reunião",
        "uncertain",
        "space_create"
      );
    }
    if (!response.ok) {
      const outcome = response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status)
        ? "failed"
        : "uncertain";
      throw new GoogleMeetApiError(
        `O Google Meet recusou a criação da reunião (HTTP ${response.status})`,
        outcome,
        "space_create"
      );
    }
    try {
      return spaceResponseSchema.parse(await response.json());
    } catch {
      throw new GoogleMeetApiError(
        "O Google Meet pode ter criado uma reunião, mas retornou uma resposta sem link válido",
        "uncertain",
        "space_create"
      );
    }
  }

  async createSpace(): Promise<GoogleMeetSpace> {
    return (await this.prepareCreateSpace()).createSpace();
  }
}

type CachedGoogleMeetClient = {
  credentialFingerprint: string;
  client: GoogleMeetClient;
};

export class GoogleMeetClientCache {
  private readonly clients = new Map<string, CachedGoogleMeetClient>();

  constructor(
    private readonly factory: (credentials: GoogleMeetCredentials) => GoogleMeetClient = createGoogleMeetClient
  ) {}

  get(tenantId: string, credentials: GoogleMeetCredentials): GoogleMeetClient {
    const credentialFingerprint = createHash("sha256")
      .update(credentials.oauthClientId)
      .update("\0")
      .update(credentials.oauthClientSecret)
      .update("\0")
      .update(credentials.refreshToken)
      .digest("hex");
    const cached = this.clients.get(tenantId);
    if (cached?.credentialFingerprint === credentialFingerprint) return cached.client;
    const client = this.factory(credentials);
    this.clients.set(tenantId, { credentialFingerprint, client });
    return client;
  }

  delete(tenantId: string): void {
    this.clients.delete(tenantId);
  }
}

export class GoogleMeetOAuthClient {
  constructor(private readonly cfg: GoogleMeetOAuthConfig, private readonly fetcher: typeof fetch = fetch) {}

  isConfigured(): boolean {
    return Boolean(
      this.cfg.GOOGLE_MEET_OAUTH_CLIENT_ID
      && this.cfg.GOOGLE_MEET_OAUTH_CLIENT_SECRET
      && this.cfg.GOOGLE_MEET_OAUTH_REDIRECT_URI
    );
  }

  authorizationUrl(state: string): string {
    if (!this.isConfigured()) throw new GoogleMeetConfigurationError("O OAuth do Google Meet não está configurado no servidor");
    const url = new URL(this.cfg.GOOGLE_MEET_OAUTH_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: this.cfg.GOOGLE_MEET_OAUTH_CLIENT_ID!,
      redirect_uri: this.cfg.GOOGLE_MEET_OAUTH_REDIRECT_URI!,
      response_type: "code",
      scope: GOOGLE_IDENTITY_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state
    }).toString();
    return url.toString();
  }

  async exchangeCode(code: string): Promise<{ email: string; refreshToken: string }> {
    if (!this.isConfigured()) throw new GoogleMeetConfigurationError("O OAuth do Google Meet não está configurado no servidor");
    let tokenResponse: Response;
    try {
      tokenResponse = await this.fetcher(this.cfg.GOOGLE_MEET_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: this.cfg.GOOGLE_MEET_OAUTH_CLIENT_ID!,
          client_secret: this.cfg.GOOGLE_MEET_OAUTH_CLIENT_SECRET!,
          redirect_uri: this.cfg.GOOGLE_MEET_OAUTH_REDIRECT_URI!
        }),
        signal: AbortSignal.timeout(this.cfg.GOOGLE_MEET_TIMEOUT_MS)
      });
    } catch {
      throw new GoogleMeetApiError("Não foi possível concluir o login com o Google");
    }
    if (!tokenResponse.ok) throw new GoogleMeetApiError(`O Google recusou o código de autorização (HTTP ${tokenResponse.status})`);
    const token = tokenResponseSchema.safeParse(await tokenResponse.json().catch(() => null));
    if (!token.success || !token.data.refresh_token) {
      throw new GoogleMeetApiError("O Google não forneceu acesso permanente; conecte a conta novamente");
    }

    let userResponse: Response;
    try {
      userResponse = await this.fetcher(this.cfg.GOOGLE_MEET_OAUTH_USERINFO_URL, {
        headers: { authorization: `Bearer ${token.data.access_token}` },
        signal: AbortSignal.timeout(this.cfg.GOOGLE_MEET_TIMEOUT_MS)
      });
    } catch {
      throw new GoogleMeetApiError("Não foi possível identificar a conta Google conectada");
    }
    if (!userResponse.ok) throw new GoogleMeetApiError(`O Google recusou a identificação da conta (HTTP ${userResponse.status})`);
    const user = userInfoSchema.safeParse(await userResponse.json().catch(() => null));
    if (!user.success || user.data.email_verified === false) throw new GoogleMeetApiError("O Google não retornou um e-mail verificado");
    return { email: user.data.email.toLocaleLowerCase("en-US"), refreshToken: token.data.refresh_token };
  }
}

export async function createGoogleMeetOAuthState(input: { tenantId: string; userId: string }, secret: string): Promise<string> {
  return new SignJWT(input)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .setJti(randomUUID())
    .sign(new TextEncoder().encode(secret));
}

export async function verifyGoogleMeetOAuthState(state: string, secret: string): Promise<{ tenantId: string; userId: string }> {
  try {
    const { payload } = await jwtVerify(state, new TextEncoder().encode(secret), { algorithms: ["HS256"] });
    return oauthStateSchema.parse(payload);
  } catch {
    throw new GoogleMeetConfigurationError("A tentativa de conexão com o Google expirou ou é inválida");
  }
}

export function createGoogleMeetClient(credentials: GoogleMeetCredentials): GoogleMeetClient {
  return new GoogleMeetClient({
    GOOGLE_MEET_TOKEN_URL: config.GOOGLE_MEET_TOKEN_URL,
    GOOGLE_MEET_API_BASE_URL: config.GOOGLE_MEET_API_BASE_URL,
    GOOGLE_MEET_TIMEOUT_MS: config.GOOGLE_MEET_TIMEOUT_MS,
    ...credentials
  });
}

export function createGoogleMeetOAuthClient(): GoogleMeetOAuthClient {
  return new GoogleMeetOAuthClient(config);
}
