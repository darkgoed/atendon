import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_CALENDAR_SCOPES,
  GoogleCalendarApiError,
  GoogleCalendarAuthRevokedError,
  GoogleCalendarClient,
  GoogleCalendarConfigurationError,
  GoogleCalendarOAuthClient,
  GoogleCalendarServiceDisabledError,
  atendonCalendarEventId,
  pkceChallenge
} from "../src/modules/scheduling/google-calendar.js";

// Resposta real do Google na troca de código traz os escopos CONCEDIDOS.
const GRANTED = GOOGLE_CALENDAR_SCOPES.join(" ");

const clientConfig = {
  oauthClientId: "client.apps.googleusercontent.com",
  oauthClientSecret: "client-secret",
  timeoutMs: 5_000
};

const REDIRECT_URI = "https://app.test/backend/scheduling/google-calendar/oauth/callback";

// Origens fixas oficiais do Google: nenhuma requisição do cliente pode sair delas.
const GOOGLE_ORIGINS = [
  "https://accounts.google.com",
  "https://oauth2.googleapis.com",
  "https://openidconnect.googleapis.com",
  "https://www.googleapis.com"
];

const eventFields = {
  summary: "Consulta",
  description: "AtendON",
  start: { dateTime: "2026-09-24T10:00:00-03:00", timeZone: "America/Sao_Paulo" },
  end: { dateTime: "2026-09-24T11:00:00-03:00", timeZone: "America/Sao_Paulo" },
  extendedProperties: { private: { atendon_appointment_id: "018f3c2e-7b1a-7c2e-9b3f-1a2b3c4d5e6f" } }
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({ access_token: "access-token", expires_in: 3600, token_type: "Bearer", ...overrides });
}

function makeClient(fetcher: ReturnType<typeof vi.fn>): GoogleCalendarClient {
  return new GoogleCalendarClient(clientConfig, fetcher as unknown as typeof fetch, () => 1_700_000_000_000);
}

function asUrlParams(init: unknown): Record<string, string> {
  return Object.fromEntries((init as RequestInit).body as unknown as URLSearchParams);
}

// Campos observados na medição de produção (READ-ONLY): status, errors[].reason,
// details[].reason e metadata.service/consumer. O corpo bruto/mensagem NÃO foi medido:
// o fixture reproduz só o que foi visto, com projeto fictício e sem atribuição inventada.
function serviceDisabledBody(): unknown {
  return {
    error: {
      status: "PERMISSION_DENIED",
      errors: [{ reason: "accessNotConfigured" }],
      details: [
        {
          reason: "SERVICE_DISABLED",
          metadata: { service: "calendar-json.googleapis.com", consumer: "projects/123456789" }
        }
      ]
    }
  };
}

describe("GoogleCalendarOAuthClient", () => {
  it("constrói a URL de consentimento com escopos do Calendar, offline e a redirect URI informada", () => {
    const url = new URL(new GoogleCalendarOAuthClient(clientConfig).authorizationUrl("estado-assinado", REDIRECT_URI));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.pathname).toBe("/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: clientConfig.oauthClientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state: "estado-assinado"
    });
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...GOOGLE_CALENDAR_SCOPES]);
    expect(() => new GoogleCalendarOAuthClient({}).authorizationUrl("s", REDIRECT_URI))
      .toThrow(GoogleCalendarConfigurationError);
  });

  it("troca o código por e-mail verificado e refresh token sem expor tokens nas URLs", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ refresh_token: "refresh-permanente", scope: GRANTED }))
      .mockResolvedValueOnce(jsonResponse({ email: "Owner@Example.com", email_verified: true }));
    const client = new GoogleCalendarOAuthClient(clientConfig, fetcher as unknown as typeof fetch);

    await expect(client.exchangeCode("codigo-google", REDIRECT_URI)).resolves.toEqual({
      email: "owner@example.com",
      refreshToken: "refresh-permanente"
    });

    const [tokenUrl, tokenInit] = fetcher.mock.calls[0];
    expect(tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(tokenInit).toMatchObject({ method: "POST", redirect: "error" });
    expect(asUrlParams(tokenInit)).toEqual({
      grant_type: "authorization_code",
      code: "codigo-google",
      client_id: clientConfig.oauthClientId,
      client_secret: clientConfig.oauthClientSecret,
      redirect_uri: REDIRECT_URI
    });
    const [userUrl, userInit] = fetcher.mock.calls[1];
    expect(userUrl).toBe("https://openidconnect.googleapis.com/v1/userinfo");
    expect(userInit).toMatchObject({ headers: { authorization: "Bearer access-token" }, redirect: "error" });
    for (const [url] of fetcher.mock.calls) expect(String(url)).not.toContain("refresh");
  });

  it("exige acesso permanente e e-mail verificado na troca de código", async () => {
    const noRefresh = vi.fn().mockResolvedValueOnce(jsonResponse({ access_token: "a", expires_in: 3600 }));
    const unverified = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ refresh_token: "r", scope: GRANTED }))
      .mockResolvedValueOnce(jsonResponse({ email: "a@b.com", email_verified: false }));
    const unverifiedMissingFlag = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ refresh_token: "r", scope: GRANTED }))
      .mockResolvedValueOnce(jsonResponse({ email: "a@b.com" }));
    const refused = vi.fn().mockResolvedValueOnce(new Response(null, { status: 400 }));

    await expect(new GoogleCalendarOAuthClient(clientConfig, noRefresh as unknown as typeof fetch).exchangeCode("c", REDIRECT_URI))
      .rejects.toMatchObject({ outcome: "failed" });
    expect(noRefresh).toHaveBeenCalledTimes(1);
    // Falha fechada na identidade: email_verified ausente ou false rejeita; o refresh token nunca
    // sai do método (nenhum retorno, nenhuma chamada depois do userinfo), então nada é persistido.
    for (const leaking of [unverified, unverifiedMissingFlag]) {
      await expect(new GoogleCalendarOAuthClient(clientConfig, leaking as unknown as typeof fetch).exchangeCode("c", REDIRECT_URI))
        .rejects.toMatchObject({ outcome: "failed" });
      expect(leaking).toHaveBeenCalledTimes(2);
    }
    await expect(new GoogleCalendarOAuthClient(clientConfig, refused as unknown as typeof fetch).exchangeCode("c", REDIRECT_URI))
      .rejects.toMatchObject({ status: 400, outcome: "failed" });
  });

  it("PKCE S256: challenge na URL e verifier só no corpo da troca", async () => {
    // Vetor do RFC 7636, apêndice B.
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const url = new URL(new GoogleCalendarOAuthClient(clientConfig).authorizationUrl("s", REDIRECT_URI, "desafio"));
    expect(url.searchParams.get("code_challenge")).toBe("desafio");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("code_verifier")).toBe(false);

    const fetcher = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ refresh_token: "r", scope: GRANTED }))
      .mockResolvedValueOnce(jsonResponse({ email: "a@b.com", email_verified: true }));
    await new GoogleCalendarOAuthClient(clientConfig, fetcher as unknown as typeof fetch).exchangeCode("c", REDIRECT_URI, "verificador");
    expect(asUrlParams(fetcher.mock.calls[0][1])).toMatchObject({ code_verifier: "verificador" });
  });

  it("403 SERVICE_DISABLED nos endpoints OAuth (token e userinfo) mantém erro genérico: o reason só classifica a API Calendar", async () => {
    const tokenRefused = vi.fn().mockResolvedValueOnce(jsonResponse(serviceDisabledBody(), 403));
    const tokenError = await new GoogleCalendarOAuthClient(clientConfig, tokenRefused as unknown as typeof fetch)
      .exchangeCode("c", REDIRECT_URI)
      .catch((caught: unknown) => caught);
    expect(tokenError).toBeInstanceOf(GoogleCalendarApiError);
    expect(tokenError).not.toBeInstanceOf(GoogleCalendarServiceDisabledError);
    expect(tokenError).toMatchObject({ status: 403, outcome: "failed" });
    expect((tokenError as Error).message).toContain("O Google recusou o código de autorização do Calendar (HTTP 403)");

    const userRefused = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ refresh_token: "r", scope: GRANTED }))
      .mockResolvedValueOnce(jsonResponse(serviceDisabledBody(), 403));
    const userError = await new GoogleCalendarOAuthClient(clientConfig, userRefused as unknown as typeof fetch)
      .exchangeCode("c", REDIRECT_URI)
      .catch((caught: unknown) => caught);
    expect(userError).toBeInstanceOf(GoogleCalendarApiError);
    expect(userError).not.toBeInstanceOf(GoogleCalendarServiceDisabledError);
    expect(userError).toMatchObject({ status: 403, outcome: "failed" });
    expect((userError as Error).message).toContain("O Google recusou a identificação da conta (HTTP 403)");
  });

  it("recusa consentimento granular sem todos os escopos da agenda (ou sem scope na resposta)", async () => {
    const partial = GOOGLE_CALENDAR_SCOPES.filter((scope) => !scope.endsWith("/calendar.events")).join(" ");
    for (const scope of [partial, undefined, "openid email"]) {
      const fetcher = vi.fn().mockResolvedValueOnce(tokenResponse({ refresh_token: "r", ...(scope === undefined ? {} : { scope }) }));
      await expect(new GoogleCalendarOAuthClient(clientConfig, fetcher as unknown as typeof fetch).exchangeCode("c", REDIRECT_URI))
        .rejects.toMatchObject({ outcome: "failed", message: expect.stringContaining("Permissões do Google Agenda incompletas") });
      // Nem chega ao userinfo: o refresh token não sai do método.
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    // Escopos extras de include_granted_scopes (ex.: Meet já concedido) não atrapalham.
    const extra = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ refresh_token: "r", scope: `${GRANTED} https://www.googleapis.com/auth/meetings.space.created` }))
      .mockResolvedValueOnce(jsonResponse({ email: "a@b.com", email_verified: true }));
    await expect(new GoogleCalendarOAuthClient(clientConfig, extra as unknown as typeof fetch).exchangeCode("c", REDIRECT_URI))
      .resolves.toMatchObject({ refreshToken: "r" });
  });

  it("revoga o refresh token no endpoint oficial; 400 (já inválido) conta como revogado", async () => {
    const ok = vi.fn().mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(new GoogleCalendarOAuthClient(clientConfig, ok as unknown as typeof fetch).revokeToken("rt")).resolves.toBe(true);
    const [url, init] = ok.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(asUrlParams(init)).toEqual({ token: "rt" });
    const stale = vi.fn().mockResolvedValueOnce(new Response(null, { status: 400 }));
    await expect(new GoogleCalendarOAuthClient(clientConfig, stale as unknown as typeof fetch).revokeToken("rt")).resolves.toBe(true);
    const down = vi.fn().mockRejectedValueOnce(new Error("rede"));
    await expect(new GoogleCalendarOAuthClient(clientConfig, down as unknown as typeof fetch).revokeToken("rt")).resolves.toBe(false);
    const unavailable = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(new GoogleCalendarOAuthClient(clientConfig, unavailable as unknown as typeof fetch).revokeToken("rt")).resolves.toBe(false);
  });
});

describe("GoogleCalendarClient", () => {
  it("falha fechada sem credenciais OAuth do cliente", async () => {
    const client = new GoogleCalendarClient({});
    await expect(client.listCalendars("refresh")).rejects.toBeInstanceOf(GoogleCalendarConfigurationError);
    await expect(client.upsertEvent("refresh", "cal", "evento", eventFields)).rejects.toBeInstanceOf(GoogleCalendarConfigurationError);
  });

  it("invalid_grant na renovação vira GoogleCalendarAuthRevokedError (terminal); outros 400 não", async () => {
    const revoked = vi.fn().mockResolvedValueOnce(jsonResponse({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400));
    const error = await makeClient(revoked).listCalendars("rt").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoogleCalendarAuthRevokedError);
    // Subclasse: todo catch existente de GoogleCalendarApiError continua valendo.
    expect(error).toBeInstanceOf(GoogleCalendarApiError);
    expect(error).toMatchObject({ outcome: "failed" });
    const otherClient = vi.fn().mockResolvedValueOnce(jsonResponse({ error: "invalid_client" }, 401));
    const other = await makeClient(otherClient).listCalendars("rt").catch((caught: unknown) => caught);
    expect(other).toBeInstanceOf(GoogleCalendarApiError);
    expect(other).not.toBeInstanceOf(GoogleCalendarAuthRevokedError);
  });

  it("renova o access token uma vez por conexão e reutiliza entre chamadas", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: "cal-1", accessRole: "writer" }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [] }))
      .mockResolvedValueOnce(tokenResponse({ access_token: "outro-access" }))
      .mockResolvedValueOnce(jsonResponse({ items: [] }));
    const client = makeClient(fetcher);

    await client.listCalendars("refresh-token");
    await client.listCalendars("refresh-token");
    await client.listCalendars("outro-refresh");
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(asUrlParams(fetcher.mock.calls[0][1])).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-token" });
    expect(asUrlParams(fetcher.mock.calls[3][1])).toMatchObject({ refresh_token: "outro-refresh" });
  });

  it("pagina o calendarList inteiro e mapeia agendas com acesso de escrita", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        items: [
          { id: "owner@gmail.com", summary: "Principal", timeZone: "America/Sao_Paulo", primary: true, accessRole: "owner" },
          { id: "equipe-ab1cd", timeZone: "America/Sao_Paulo", accessRole: "writer" }
        ],
        nextPageToken: "pagina-2"
      }))
      .mockResolvedValueOnce(jsonResponse({
        items: [{ id: "sala@group.calendar.google.com", summary: "Sala", primary: false, accessRole: "writer" }]
      }));
    const client = makeClient(fetcher);

    await expect(client.listCalendars("refresh-token")).resolves.toEqual([
      { id: "owner@gmail.com", name: "Principal", timeZone: "America/Sao_Paulo", primary: true },
      { id: "equipe-ab1cd", name: "equipe-ab1cd", timeZone: "America/Sao_Paulo", primary: false },
      { id: "sala@group.calendar.google.com", name: "Sala", timeZone: null, primary: false }
    ]);

    const [firstUrl, firstInit] = fetcher.mock.calls[1];
    expect(firstUrl).toBe("https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer&maxResults=250");
    expect(firstInit).toMatchObject({ method: "GET", headers: { authorization: "Bearer access-token" } });
    expect(fetcher.mock.calls[2][0]).toBe("https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer&maxResults=250&pageToken=pagina-2");
  });

  it("aplica defesa em profundidade: mantém só papéis de escrita e descarta accessRole ausente", async () => {
    // minAccessRole=writer já limita a resposta na origem para todas as contas Google; o filtro por
    // item é defesa em profundidade contra resposta malformada/inconsistente. writerWithoutPrivateAccess
    // pode ler/gravar eventos não privados — os nossos são criados com visibilidade default, então
    // é escrita suficiente. Item sem accessRole: falha fechada, descartado sem adivinhar.
    const fetcher = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        items: [
          { id: "leitor", summary: "Leitor", accessRole: "reader" },
          { id: "dono", summary: "Dono", accessRole: "owner" },
          { id: "escritor", summary: "Escritor", accessRole: "writer" },
          { id: "escritor-limitado", summary: "Escritor Limitado", accessRole: "writerWithoutPrivateAccess" },
          { id: "sem-papel", summary: "Sem Papel" }
        ]
      }));
    const client = makeClient(fetcher);

    await expect(client.listCalendars("refresh-token")).resolves.toEqual([
      { id: "dono", name: "Dono", timeZone: null, primary: false },
      { id: "escritor", name: "Escritor", timeZone: null, primary: false },
      { id: "escritor-limitado", name: "Escritor Limitado", timeZone: null, primary: false }
    ]);
  });

  it("consulta freeBusy com janela e item únicos e devolve os intervalos ocupados", async () => {
    const busy = [{ start: "2026-09-24T12:00:00Z", end: "2026-09-24T13:00:00Z" }];
    const fetcher = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ calendars: { "cal-1": { busy } } }));
    const client = makeClient(fetcher);

    await expect(client.freeBusy("refresh-token", "cal-1", "2026-09-24T08:00:00Z", "2026-09-24T18:00:00Z")).resolves.toEqual(busy);

    const [url, init] = fetcher.mock.calls[1];
    expect(url).toBe("https://www.googleapis.com/calendar/v3/freeBusy");
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      timeMin: "2026-09-24T08:00:00Z",
      timeMax: "2026-09-24T18:00:00Z",
      items: [{ id: "cal-1" }]
    });
  });

  it("falha fechada quando o Google reporta erro no calendário ou omite a entrada", async () => {
    const withErrors = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        calendars: { "cal-1": { busy: [], errors: [{ domain: "global", reason: "notFound" }] } }
      }));
    const missing = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ calendars: {} }));

    await expect(makeClient(withErrors).freeBusy("r", "cal-1", "2026-09-24T08:00:00Z", "2026-09-24T18:00:00Z"))
      .rejects.toMatchObject({ outcome: "failed" });
    await expect(makeClient(missing).freeBusy("r", "cal-1", "2026-09-24T08:00:00Z", "2026-09-24T18:00:00Z"))
      .rejects.toBeInstanceOf(GoogleCalendarApiError);
  });

  it("atualiza o evento existente via PATCH quando não há etag informado", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ id: "evento-1", etag: "\"etag-1\"", status: "confirmed" }));
    const client = makeClient(fetcher);

    await expect(client.upsertEvent("refresh-token", "cal-1", "evento-1", eventFields))
      .resolves.toMatchObject({ id: "evento-1", etag: "\"etag-1\"" });

    const [url, init] = fetcher.mock.calls[1];
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/cal-1/events/evento-1");
    expect(init).toMatchObject({
      method: "PATCH",
      headers: { authorization: "Bearer access-token", "content-type": "application/json" }
    });
    expect((init as RequestInit).headers).not.toHaveProperty("if-match");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(eventFields);
  });

  it("cria o evento com ID determinístico quando o PATCH não encontra e reaplica em corrida de retry", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 409 } }), { status: 409 }))
      .mockResolvedValueOnce(jsonResponse({ id: "evento-1", etag: "\"etag-2\"" }));
    const client = makeClient(fetcher);

    await expect(client.upsertEvent("r", "cal-1", "evento-1", eventFields)).resolves.toMatchObject({ id: "evento-1" });

    const [insertUrl, insertInit] = fetcher.mock.calls[2];
    // events.insert oficial: POST na coleção /events (não no path do evento); ID no corpo.
    expect(insertUrl).toBe("https://www.googleapis.com/calendar/v3/calendars/cal-1/events");
    expect(insertInit).toMatchObject({ method: "POST" });
    expect(JSON.parse((insertInit as RequestInit).body as string)).toEqual({ ...eventFields, id: "evento-1" });
    expect(fetcher.mock.calls[3][1]).toMatchObject({ method: "PATCH" });
  });

  it("usa If-Match com o etag informado e não recria o evento por conta própria", async () => {
    const conflict = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 412 } }), { status: 412 }));
    const removed = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    const error = await makeClient(conflict).upsertEvent("r", "cal-1", "evento-1", eventFields, "\"etag-1\"")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoogleCalendarApiError);
    expect(error).toMatchObject({ status: 412, outcome: "failed" });
    expect(conflict.mock.calls[1][1]).toMatchObject({ headers: { "if-match": "\"etag-1\"" } });
    expect(conflict).toHaveBeenCalledTimes(2);

    await expect(makeClient(removed).upsertEvent("r", "cal-1", "evento-1", eventFields, "\"etag-1\""))
      .rejects.toMatchObject({ status: 404 });
    expect(removed).toHaveBeenCalledTimes(2);
  });

  it("lê o evento com etag e trata exclusão já confirmada como sucesso idempotente", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ id: "evento-1", etag: "\"etag-1\"", status: "confirmed" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 410 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    const client = makeClient(fetcher);

    await expect(client.getEvent("refresh-token", "cal-1", "evento-1"))
      .resolves.toMatchObject({ id: "evento-1", etag: "\"etag-1\"", status: "confirmed" });
    expect(fetcher.mock.calls[1][0]).toBe("https://www.googleapis.com/calendar/v3/calendars/cal-1/events/evento-1");

    await expect(client.deleteEvent("refresh-token", "cal-1", "evento-1")).resolves.toBeUndefined();
    await expect(client.deleteEvent("refresh-token", "cal-1", "evento-1")).resolves.toBeUndefined();
    await expect(client.deleteEvent("refresh-token", "cal-1", "evento-1")).resolves.toBeUndefined();
    await expect(client.deleteEvent("refresh-token", "cal-1", "evento-1")).rejects.toMatchObject({ status: 500, outcome: "uncertain" });
  });

  it("classifica falha de rede: leitura tenta de novo, mutação fica incerta", async () => {
    const readFailure = vi.fn().mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    await expect(makeClient(readFailure).listCalendars("r")).rejects.toMatchObject({ outcome: "safe_to_retry" });

    const mutationFailure = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    await expect(makeClient(mutationFailure).upsertEvent("r", "cal-1", "evento-1", eventFields))
      .rejects.toMatchObject({ outcome: "uncertain" });
  });

  it("403 SERVICE_DISABLED no calendarList vira erro dedicado: mandar ativar a API, sem pedir reconexão e sem vazar corpo", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse(serviceDisabledBody(), 403));
    const error = await makeClient(fetcher).listCalendars("refresh-token").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GoogleCalendarApiError);
    expect(error).toMatchObject({ name: "GoogleCalendarServiceDisabledError", outcome: "failed", status: 403 });
    expect(error).not.toBeInstanceOf(GoogleCalendarAuthRevokedError);
    const message = (error as Error).message;
    expect(message).toContain("Ative a \"Google Calendar API\"");
    expect(message).toContain("não é preciso reconectar");
    // Nenhum conteúdo do corpo do Google entra na mensagem: nem consumer/project, nem serviço.
    expect(message).not.toContain("123456789");
    expect(message).not.toContain("calendar-json.googleapis.com");
  });

  it("403 SERVICE_DISABLED no freeBusy recebe a mesma classificação pelo ponto compartilhado", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse(serviceDisabledBody(), 403));
    const error = await makeClient(fetcher)
      .freeBusy("refresh-token", "cal-1", "2026-09-24T08:00:00Z", "2026-09-24T18:00:00Z")
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "GoogleCalendarServiceDisabledError", outcome: "failed", status: 403 });
    expect(error).not.toBeInstanceOf(GoogleCalendarAuthRevokedError);
  });

  it("403 com SERVICE_DISABLED apenas em error.details também é serviço desativado (listEvents)", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        error: {
          code: 403,
          message: "Permission denied",
          details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", domain: "googleapis.com" }]
        }
      }, 403));
    const error = await makeClient(fetcher)
      .listEvents("refresh-token", "cal-1", "2026-09-24T08:00:00Z", "2026-09-24T18:00:00Z")
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "GoogleCalendarServiceDisabledError", outcome: "failed", status: 403 });
    expect(error).not.toBeInstanceOf(GoogleCalendarAuthRevokedError);
  });

  it("403 com outro motivo mantém a classificação atual: nem serviço desativado, nem revogado", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        error: {
          code: 403,
          message: "The user does not have sufficient permissions",
          errors: [{ domain: "global", reason: "insufficientPermissions" }],
          status: "PERMISSION_DENIED"
        }
      }, 403));
    const error = await makeClient(fetcher).listCalendars("refresh-token").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GoogleCalendarApiError);
    expect(error).toMatchObject({ name: "GoogleCalendarApiError", outcome: "failed", status: 403 });
    const message = (error as Error).message;
    expect(message).toContain("O Google recusou a listagem de agendas (HTTP 403)");
    expect(error).not.toBeInstanceOf(GoogleCalendarAuthRevokedError);
  });

  it("403 SERVICE_DISABLED na renovação do access token (endpoint OAuth) mantém erro genérico", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse(serviceDisabledBody(), 403));
    const error = await makeClient(fetcher).listCalendars("refresh-token").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoogleCalendarApiError);
    expect(error).not.toBeInstanceOf(GoogleCalendarServiceDisabledError);
    expect(error).toMatchObject({ status: 403, outcome: "failed" });
    expect((error as Error).message).toContain("O Google recusou a renovação do acesso ao Calendar (HTTP 403)");
  });

  it("corpo de erro maior que o cap não é interpretado: leitura truncada, falha fechada", async () => {
    const padded = { error: { code: 403, padding: "x".repeat(20_000), details: [{ reason: "SERVICE_DISABLED" }] } };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify(padded), { status: 403 }));
    const error = await makeClient(fetcher).listCalendars("refresh-token").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoogleCalendarApiError);
    expect(error).not.toBeInstanceOf(GoogleCalendarServiceDisabledError);
    expect(error).toMatchObject({ status: 403, outcome: "failed" });
  });

  it("mantém toda requisição nas origens fixas do Google, sem redirect e com timeout", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: "cal-1", summary: "Agenda", primary: true, accessRole: "writer" }] }))
      .mockResolvedValueOnce(jsonResponse({ calendars: { "cal-1": { busy: [] } } }))
      .mockResolvedValueOnce(jsonResponse({ id: "evento-1", etag: "\"etag-1\"" }));
    const client = makeClient(fetcher);

    await client.listCalendars("refresh-token");
    await client.freeBusy("refresh-token", "cal-1", "2026-09-24T08:00:00Z", "2026-09-24T18:00:00Z");
    await client.upsertEvent("refresh-token", "cal-1", "evento-1", eventFields);

    for (const [url, init] of fetcher.mock.calls) {
      expect(GOOGLE_ORIGINS).toContain(new URL(String(url)).origin);
      expect(init).toMatchObject({ redirect: "error" });
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("não expõe o refresh token fora da chamada de token do OAuth", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: "cal-1", accessRole: "writer" }] }))
      .mockResolvedValueOnce(jsonResponse({ id: "evento-1", etag: "\"etag-1\"" }));
    const client = makeClient(fetcher);
    await client.listCalendars("refresh-secreto");
    await client.upsertEvent("refresh-secreto", "cal-1", "evento-1", eventFields);

    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).not.toContain("refresh-secreto");
      const body = (init as RequestInit).body;
      const isTokenCall = url === "https://oauth2.googleapis.com/token";
      if (isTokenCall) {
        expect(asUrlParams(init).refresh_token).toBe("refresh-secreto");
      } else {
        expect(body === undefined || String(body)).not.toContain("refresh-secreto");
        expect(JSON.stringify((init as RequestInit).headers)).not.toContain("refresh-secreto");
      }
    }
  });
});

describe("atendonCalendarEventId", () => {
  it("deriva ID determinístico dentro do alfabeto base32hex exigido pelo Google", () => {
    expect(atendonCalendarEventId("018F3C2E-7B1A-7C2E-9B3F-1A2B3C4D5E6F"))
      .toBe("atendon018f3c2e7b1a7c2e9b3f1a2b3c4d5e6f");
    expect(atendonCalendarEventId("018f3c2e7b1a7c2e9b3f1a2b3c4d5e6f"))
      .toBe("atendon018f3c2e7b1a7c2e9b3f1a2b3c4d5e6f");
    expect(() => atendonCalendarEventId("018f3c2e-7b1a-7c2e-9b3f-1a2b3c4d5ex6f")).toThrow(); // 'x' fora de a-v
  });
});
