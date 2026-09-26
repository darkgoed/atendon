import { createHash } from "node:crypto";
import { z } from "zod";
import { config } from "../../config.js";

// Endpoints oficiais documentados do Google. Origens FIXAS: nenhuma URL de rede vem de config ou de fora
// deste módulo, e googleFetch recusa qualquer origem fora desta lista.
const GOOGLE_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_CALENDAR_API_URL = "https://www.googleapis.com/calendar/v3";
const GOOGLE_ALLOWED_ORIGINS = new Set([
  "https://accounts.google.com",
  "https://oauth2.googleapis.com",
  "https://openidconnect.googleapis.com",
  "https://www.googleapis.com"
]);
const DEFAULT_TIMEOUT_MS = 15_000;
const MUTATING_METHODS = new Set(["POST", "PATCH", "DELETE"]);

// Escopos exigidos por endpoint, verificados nos docs oficiais: events → calendar.events;
// calendarList.list → calendar.calendarlist.readonly; freeBusy → calendar.freebusy; identidade → openid email.
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "openid",
  "email"
] as const;
// Escopos sem os quais a integração não funciona. Com consentimento granular o
// usuário pode desmarcar qualquer um: a conexão só é aceita com todos.
const REQUIRED_CALENDAR_SCOPES = GOOGLE_CALENDAR_SCOPES.filter((scope) => scope.startsWith("https://"));

/** PKCE S256 (RFC 7636): code_challenge = BASE64URL(SHA256(code_verifier)). */
export function pkceChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

export type GoogleCalendarOptions = {
  oauthClientId?: string;
  oauthClientSecret?: string;
  timeoutMs?: number;
};

export type GoogleCalendarSummary = { id: string; name: string; timeZone: string | null; primary: boolean };
export type GoogleCalendarBusyInterval = { start: string; end: string };

export type GoogleCalendarEventFields = {
  summary?: string;
  description?: string;
  location?: string;
  status?: "confirmed" | "cancelled";
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
  // conferenceData é usado apenas por chamadores que pedem Meet explicitamente; o sync nunca envia.
  conferenceData?: Record<string, unknown>;
};

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().default(3600),
  token_type: z.string().default("Bearer"),
  // Escopos EFETIVAMENTE concedidos (separados por espaço); o Google sempre devolve na troca de código.
  scope: z.string().optional()
});

// Falha fechada: docs OIDC do Google marcam email_verified como booleano; só e-mail verificado (true) é aceito.
const userInfoSchema = z.object({ email: z.string().email(), email_verified: z.literal(true) });

const calendarListPageSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1),
    summary: z.string().optional(),
    timeZone: z.string().optional(),
    primary: z.boolean().optional(),
    // Papel declarado (docs: accessRole); opcional para papel desconhecido cair no filtro abaixo, não invalidar a página.
    accessRole: z.string().optional()
  })),
  nextPageToken: z.string().optional()
});

// Papéis que permitem gravar eventos. minAccessRole=writer já limita a resposta na origem para todas
// as contas Google; repetir o filtro por item é defesa em profundidade contra resposta malformada ou
// inconsistente. writerWithoutPrivateAccess pode ler/gravar eventos não privados — os nossos são
// criados com visibilidade default, então é escrita suficiente. Sem accessRole: falha fechada.
const WRITABLE_ACCESS_ROLES = new Set(["owner", "writer", "writerWithoutPrivateAccess"]);

const freeBusyResponseSchema = z.object({
  calendars: z.record(z.string(), z.object({
    busy: z.array(z.object({ start: z.string().min(1), end: z.string().min(1) })),
    errors: z.array(z.object({ domain: z.string().min(1), reason: z.string().min(1) })).optional()
  }))
});

const eventResourceSchema = z.object({
  id: z.string().min(1),
  etag: z.string().min(1),
  status: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: z.object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() }).optional(),
  end: z.object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() }).optional()
}).passthrough();

export type GoogleCalendarEvent = z.infer<typeof eventResourceSchema>;

const eventListPageSchema = z.object({
  items: z.array(eventResourceSchema),
  nextPageToken: z.string().optional()
});

export class GoogleCalendarConfigurationError extends Error {
  readonly statusCode = 503;
  constructor(message = "A conexão OAuth com o Google Calendar não está configurada") {
    super(message);
    this.name = "GoogleCalendarConfigurationError";
  }
}

export class GoogleCalendarApiError extends Error {
  readonly statusCode = 502;
  constructor(
    message: string,
    readonly outcome: "safe_to_retry" | "failed" | "uncertain" = "safe_to_retry",
    readonly status?: number
  ) {
    super(message);
    this.name = "GoogleCalendarApiError";
  }
}

// Acesso revogado/expirado no Google (token endpoint devolveu invalid_grant):
// definitivo até o usuário reconectar — retentar só repete a recusa. Subclasse
// para que todo catch/rethrow existente de GoogleCalendarApiError continue valendo.
export class GoogleCalendarAuthRevokedError extends GoogleCalendarApiError {
  constructor() {
    super("O acesso ao Google Agenda foi revogado ou expirou; reconecte a conta", "failed", 400);
    this.name = "GoogleCalendarAuthRevokedError";
  }
}

// invalid_grant é terminal até reconectar: registra na conexão (painel pede
// reconexão; reconciliação para de insistir). A reconexão (callback) limpa.
export async function markCalendarConnectionAuthRevoked(
  client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  tenantId: string,
  connectionId: string
): Promise<void> {
  await client.query(
    `UPDATE scheduling_calendar_connections
     SET auth_error=$3, auth_error_at=now(), updated_at=now()
     WHERE tenant_id=$1 AND id=$2 AND auth_error IS NULL`,
    [tenantId, connectionId, new GoogleCalendarAuthRevokedError().message]
  );
}

async function googleFetch(fetcher: typeof fetch, timeoutMs: number, url: string, init: RequestInit): Promise<Response> {
  const origin = new URL(url).origin;
  if (!GOOGLE_ALLOWED_ORIGINS.has(origin)) throw new Error(`Origem fixa do Google violada: ${origin}`);
  return fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
}

function googleHttpError(status: number, message: string, mutating: boolean): GoogleCalendarApiError {
  const retriable = status === 408 || status === 409 || status === 429 || status >= 500;
  return new GoogleCalendarApiError(
    `${message} (HTTP ${status})`,
    !retriable && status >= 400 ? "failed" : mutating ? "uncertain" : "safe_to_retry",
    status
  );
}

function eventPath(calendarId: string, eventId: string): string {
  return `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
}

function eventQuery(fields: GoogleCalendarEventFields): string {
  return fields.conferenceData === undefined ? "" : "?conferenceDataVersion=1";
}

export class GoogleCalendarOAuthClient {
  constructor(private readonly options: GoogleCalendarOptions, private readonly fetcher: typeof fetch = fetch) {}

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  isConfigured(): boolean {
    return Boolean(this.options.oauthClientId?.trim() && this.options.oauthClientSecret?.trim());
  }

  authorizationUrl(state: string, redirectUri: string, codeChallenge?: string): string {
    if (!this.isConfigured()) throw new GoogleCalendarConfigurationError("O OAuth do Google Calendar não está configurado no servidor");
    const url = new URL(GOOGLE_OAUTH_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: this.options.oauthClientId!.trim(),
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GOOGLE_CALENDAR_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
      ...(codeChallenge ? { code_challenge: codeChallenge, code_challenge_method: "S256" } : {})
    }).toString();
    return url.toString();
  }

  async exchangeCode(code: string, redirectUri: string, codeVerifier?: string): Promise<{ email: string; refreshToken: string }> {
    if (!this.isConfigured()) throw new GoogleCalendarConfigurationError("O OAuth do Google Calendar não está configurado no servidor");
    let tokenResponse: Response;
    try {
      tokenResponse = await googleFetch(this.fetcher, this.timeoutMs, GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: this.options.oauthClientId!.trim(),
          client_secret: this.options.oauthClientSecret!.trim(),
          redirect_uri: redirectUri,
          ...(codeVerifier ? { code_verifier: codeVerifier } : {})
        })
      });
    } catch {
      throw new GoogleCalendarApiError("Não foi possível concluir a conexão com o Google Calendar");
    }
    if (!tokenResponse.ok) throw googleHttpError(tokenResponse.status, "O Google recusou o código de autorização do Calendar", false);
    const token = tokenResponseSchema.safeParse(await tokenResponse.json().catch(() => null));
    if (!token.success || !token.data.refresh_token) {
      throw new GoogleCalendarApiError("O Google não forneceu acesso permanente; conecte a conta novamente", "failed");
    }
    // Falha fechada no consentimento granular: sem TODOS os escopos da agenda a
    // conexão nasceria quebrada (sync/freeBusy 403 em loop). Resposta sem scope
    // também é recusada — não dá para provar o que foi concedido.
    const granted = new Set((token.data.scope ?? "").split(/\s+/).filter(Boolean));
    if (REQUIRED_CALENDAR_SCOPES.some((scope) => !granted.has(scope))) {
      throw new GoogleCalendarApiError("Permissões do Google Agenda incompletas; conecte novamente e aceite todas as permissões", "failed");
    }

    let userResponse: Response;
    try {
      userResponse = await googleFetch(this.fetcher, this.timeoutMs, GOOGLE_USERINFO_URL, {
        headers: { authorization: `Bearer ${token.data.access_token}` }
      });
    } catch {
      throw new GoogleCalendarApiError("Não foi possível identificar a conta Google conectada");
    }
    if (!userResponse.ok) throw googleHttpError(userResponse.status, "O Google recusou a identificação da conta", false);
    // userInfoSchema exige email_verified === true; parse com flag ausente/false falha e rejeita a conexão.
    const user = userInfoSchema.safeParse(await userResponse.json().catch(() => null));
    if (!user.success) {
      throw new GoogleCalendarApiError("O Google não retornou um e-mail verificado", "failed");
    }
    return { email: user.data.email.toLocaleLowerCase("en-US"), refreshToken: token.data.refresh_token };
  }

  /**
   * Revoga o refresh token no Google (best-effort). Revogar derruba a concessão
   * INTEIRA (conta Google × client OAuth) — quem chama garante que nenhuma
   * outra integração usa a mesma conta com este client. true = revogado ou já
   * inválido (400).
   */
  async revokeToken(refreshToken: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      const response = await googleFetch(this.fetcher, this.timeoutMs, GOOGLE_REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken })
      });
      return response.ok || response.status === 400;
    } catch {
      return false;
    }
  }
}

type CachedToken = { value: string; expiresAt: number };

export class GoogleCalendarClient {
  // ponytail: cache de access token por refresh token; conexões são poucas e tokens rotacionados
  // apenas deixam entradas ociosas (a nova chave é cacheada na rotação) — limpar se isso virar problema.
  private readonly tokens = new Map<string, CachedToken>();

  constructor(
    private readonly options: GoogleCalendarOptions,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {}

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  isConfigured(): boolean {
    return Boolean(this.options.oauthClientId?.trim() && this.options.oauthClientSecret?.trim());
  }

  private async accessToken(refreshToken: string): Promise<string> {
    if (!this.isConfigured()) throw new GoogleCalendarConfigurationError();
    const cached = this.tokens.get(refreshToken);
    if (cached && cached.expiresAt - 60_000 > this.now()) return cached.value;

    let response: Response;
    try {
      response = await googleFetch(this.fetcher, this.timeoutMs, GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: this.options.oauthClientId!.trim(),
          client_secret: this.options.oauthClientSecret!.trim(),
          refresh_token: refreshToken
        })
      });
    } catch {
      throw new GoogleCalendarApiError("Não foi possível renovar o acesso ao Google Calendar");
    }
    if (!response.ok) {
      // invalid_grant = refresh token revogado/expirado (docs OAuth do Google): terminal.
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      if (response.status === 400 && body?.error === "invalid_grant") throw new GoogleCalendarAuthRevokedError();
      throw googleHttpError(response.status, "O Google recusou a renovação do acesso ao Calendar", false);
    }
    let token: z.infer<typeof tokenResponseSchema>;
    try {
      token = tokenResponseSchema.parse(await response.json());
    } catch {
      throw new GoogleCalendarApiError("O Google retornou uma autenticação inválida para o Calendar");
    }
    this.tokens.set(refreshToken, { value: token.access_token, expiresAt: this.now() + token.expires_in * 1000 });
    return token.access_token;
  }

  private async calendarRequest(
    accessToken: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    init: { json?: unknown; etag?: string } = {}
  ): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
    if (init.json !== undefined) headers["content-type"] = "application/json";
    if (init.etag !== undefined) headers["if-match"] = init.etag;
    try {
      return await googleFetch(this.fetcher, this.timeoutMs, `${GOOGLE_CALENDAR_API_URL}${path}`, {
        method,
        headers,
        body: init.json === undefined ? undefined : JSON.stringify(init.json)
      });
    } catch {
      // Mutação sem resposta: não se sabe se o Google aplicou a mudança — nunca classificar como retry seguro.
      throw new GoogleCalendarApiError(
        "Não foi possível falar com a API do Google Calendar",
        MUTATING_METHODS.has(method) ? "uncertain" : "safe_to_retry"
      );
    }
  }

  private async parseEvent(response: Response, mutating: boolean): Promise<GoogleCalendarEvent> {
    try {
      return eventResourceSchema.parse(await response.json());
    } catch {
      throw new GoogleCalendarApiError(
        mutating ? "O Google pode ter aplicado a mudança, mas retornou um evento inválido" : "O Google retornou um evento inválido",
        mutating ? "uncertain" : "safe_to_retry"
      );
    }
  }

  async listCalendars(refreshToken: string): Promise<GoogleCalendarSummary[]> {
    const accessToken = await this.accessToken(refreshToken);
    const calendars: GoogleCalendarSummary[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ minAccessRole: "writer", maxResults: "250" });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await this.calendarRequest(accessToken, "GET", `/users/me/calendarList?${query.toString()}`);
      if (!response.ok) throw googleHttpError(response.status, "O Google recusou a listagem de agendas", false);
      let page: z.infer<typeof calendarListPageSchema>;
      try {
        page = calendarListPageSchema.parse(await response.json());
      } catch {
        throw new GoogleCalendarApiError("O Google retornou uma lista de agendas inválida");
      }
      for (const item of page.items) {
        // Falha fechada: sem accessRole declarado, descarta sem adivinhar.
        if (item.accessRole === undefined || !WRITABLE_ACCESS_ROLES.has(item.accessRole)) continue;
        calendars.push({ id: item.id, name: item.summary ?? item.id, timeZone: item.timeZone ?? null, primary: item.primary ?? false });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return calendars;
  }

  async freeBusy(refreshToken: string, calendarId: string, start: string, end: string): Promise<GoogleCalendarBusyInterval[]> {
    const accessToken = await this.accessToken(refreshToken);
    const response = await this.calendarRequest(accessToken, "POST", "/freeBusy", {
      json: { timeMin: start, timeMax: end, items: [{ id: calendarId }] }
    });
    if (!response.ok) throw googleHttpError(response.status, "O Google recusou a consulta de disponibilidade", false);
    let data: z.infer<typeof freeBusyResponseSchema>;
    try {
      data = freeBusyResponseSchema.parse(await response.json());
    } catch {
      throw new GoogleCalendarApiError("O Google retornou uma resposta de disponibilidade inválida");
    }
    const entry = data.calendars[calendarId];
    // Falha fechada (spec): erro no calendário ou entrada ausente → sem disponibilidade confiável.
    if (!entry || entry.errors?.length) {
      throw new GoogleCalendarApiError("O Google não conseguiu calcular a disponibilidade da agenda", "failed");
    }
    return entry.busy;
  }

  // Eventos INDIVIDUAIS (com ID) no intervalo: freeBusy mescla eventos coincidentes
  // em um único bloco, então igualdade de intervalo não identifica o evento nosso —
  // a exclusão do evento vinculado próprio precisa de identidade, não de intervalo.
  async listEvents(refreshToken: string, calendarId: string, start: string, end: string): Promise<GoogleCalendarEvent[]> {
    const accessToken = await this.accessToken(refreshToken);
    const events: GoogleCalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ timeMin: start, timeMax: end, singleEvents: "true", showDeleted: "false", maxResults: "250" });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await this.calendarRequest(accessToken, "GET", `/calendars/${encodeURIComponent(calendarId)}/events?${query.toString()}`);
      if (!response.ok) throw googleHttpError(response.status, "O Google recusou a listagem de eventos", false);
      let page: z.infer<typeof eventListPageSchema>;
      try {
        page = eventListPageSchema.parse(await response.json());
      } catch {
        throw new GoogleCalendarApiError("O Google retornou uma lista de eventos inválida");
      }
      for (const item of page.items) {
        if (item.status !== "cancelled") events.push(item);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return events;
  }

  async upsertEvent(
    refreshToken: string,
    calendarId: string,
    eventId: string,
    fields: GoogleCalendarEventFields,
    etag?: string
  ): Promise<GoogleCalendarEvent> {
    const accessToken = await this.accessToken(refreshToken);
    if (etag !== undefined) {
      // Com etag: atualização com concorrência estrita; 404 (removido) e 412 (conflito) voltam
      // para o sincronizador decidir — nunca recriar um evento que o usuário pode ter apagado.
      return this.patchEvent(accessToken, calendarId, eventId, fields, etag);
    }
    try {
      return await this.patchEvent(accessToken, calendarId, eventId, fields);
    } catch (error) {
      if (!(error instanceof GoogleCalendarApiError) || error.status !== 404) throw error;
      try {
        return await this.insertEvent(accessToken, calendarId, eventId, fields);
      } catch (insertError) {
        if (insertError instanceof GoogleCalendarApiError && insertError.status === 409) {
          // O evento surgiu em paralelo (retry concorrente com o mesmo ID determinístico): aplica nossos campos.
          return this.patchEvent(accessToken, calendarId, eventId, fields);
        }
        throw insertError;
      }
    }
  }

  private async insertEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    fields: GoogleCalendarEventFields
  ): Promise<GoogleCalendarEvent> {
    // events.insert oficial: POST na COLEÇÃO de eventos; o ID vai no corpo (id), não no path.
    const response = await this.calendarRequest(accessToken, "POST", `/calendars/${encodeURIComponent(calendarId)}/events${eventQuery(fields)}`, {
      json: { ...fields, id: eventId }
    });
    if (!response.ok) throw googleHttpError(response.status, "O Google recusou a criação do evento no Calendar", true);
    return this.parseEvent(response, true);
  }

  private async patchEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    fields: GoogleCalendarEventFields,
    etag?: string
  ): Promise<GoogleCalendarEvent> {
    const response = await this.calendarRequest(accessToken, "PATCH", `${eventPath(calendarId, eventId)}${eventQuery(fields)}`, {
      json: fields,
      etag
    });
    if (!response.ok) throw googleHttpError(response.status, "O Google recusou a atualização do evento no Calendar", true);
    return this.parseEvent(response, true);
  }

  async getEvent(refreshToken: string, calendarId: string, eventId: string): Promise<GoogleCalendarEvent> {
    const accessToken = await this.accessToken(refreshToken);
    const response = await this.calendarRequest(accessToken, "GET", eventPath(calendarId, eventId));
    if (!response.ok) throw googleHttpError(response.status, "O Google recusou a leitura do evento no Calendar", false);
    return this.parseEvent(response, false);
  }

  async deleteEvent(refreshToken: string, calendarId: string, eventId: string): Promise<void> {
    const accessToken = await this.accessToken(refreshToken);
    const response = await this.calendarRequest(accessToken, "DELETE", eventPath(calendarId, eventId));
    // 404/410 = evento já removido no Google: exclusão idempotente confirmada (spec: só apagar vínculo após confirmação).
    if (response.ok || response.status === 404 || response.status === 410) return;
    throw googleHttpError(response.status, "O Google recusou a exclusão do evento no Calendar", true);
  }
}

// IDs de evento do Google (docs events.insert): base32hex — letras a-v e dígitos 0-9, 5 a 1024 caracteres.
const GOOGLE_EVENT_ID_PATTERN = /^[a-v0-9]{5,1024}$/;

export function atendonCalendarEventId(appointmentId: string): string {
  const eventId = `atendon${appointmentId.replace(/-/g, "").toLowerCase()}`;
  if (!GOOGLE_EVENT_ID_PATTERN.test(eventId)) {
    throw new Error("appointmentId não gera um ID de evento válido para o Google Calendar");
  }
  return eventId;
}

// Reaproveita o MESMO client OAuth do Google usado pelo Meet (spec: nenhuma credencial nova;
// nunca usa o refresh token global do Meet — este módulo só emite token por conexão de Calendar).
export function createGoogleCalendarOAuthClient(): GoogleCalendarOAuthClient {
  return new GoogleCalendarOAuthClient({
    oauthClientId: config.GOOGLE_MEET_OAUTH_CLIENT_ID,
    oauthClientSecret: config.GOOGLE_MEET_OAUTH_CLIENT_SECRET
  });
}

export function createGoogleCalendarClient(): GoogleCalendarClient {
  return new GoogleCalendarClient({
    oauthClientId: config.GOOGLE_MEET_OAUTH_CLIENT_ID,
    oauthClientSecret: config.GOOGLE_MEET_OAUTH_CLIENT_SECRET
  });
}
