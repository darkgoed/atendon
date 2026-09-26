import https from "node:https";
import { decryptCredentials } from "./credentials.js";

/**
 * Cliente da API Pix Automático da Efí (GerenciaNet).
 *
 * Fluxo implementado — jornada 2 (QR Code para cobranças recorrentes futuras),
 * conforme https://dev.efipay.com.br/docs/api-pix/pix-automatico/ :
 *   1. POST /v2/locrec       -> createLocation()
 *   2. POST /v2/rec          -> createRecurrence() (loc, calendario.dataInicial,
 *                               periodicidade MENSAL, valor.valorRec, devedor)
 *   3. GET  /v2/rec/:idRec   -> getRecurrence() (dadosQR.pixCopiaECola)
 *   4. PUT  /v2/cobr/:txid   -> createCharge() (idRec, calendario.dataDeVencimento,
 *                               valor.original)
 *   5. GET  /v2/cobr/:txid   -> getCharge() (confirmação)
 *   Cancelamento de cobrança: PATCH /v2/cobr/:txid {"status":"CANCELADA"}.
 *
 * A API NÃO documenta cancelamento da recorrência em si (apenas da solicitação
 * de confirmação, /v2/solicrec) — por isso este cliente não expõe tal método.
 *
 * Autenticação: OAuth2 client credentials em POST /oauth/token no MESMO host da
 * API Pix, com HTTP Basic (clientId:clientSecret) e obrigatoriamente mTLS — o
 * certificado P12 do cliente é exigido em TODAS as requisições, inclusive a de
 * autorização (https://dev.efipay.com.br/docs/api-pix/credenciais/).
 */

/** Hosts fixos da API Pix — nenhuma URL configurável, sem superfície de SSRF. */
export const EFI_PIX_HOSTS = { sandbox: "pix-h.api.efipay.com.br", production: "pix.api.efipay.com.br" } as const;

export interface EfiTransportRequest { method: "GET" | "POST" | "PUT" | "PATCH"; path: string; body?: string; headers: Record<string, string>; }
export interface EfiTransportResponse { statusCode: number; text: string; }
/** Ponto de injeção para testes: transporta uma requisição HTTP já montada. */
export type EfiTransport = (request: EfiTransportRequest) => Promise<EfiTransportResponse>;

export interface EfiDebtor { nome: string; cpf?: string; cnpj?: string; }
export interface EfiRecurrenceInput {
  /** id retornado por createLocation() (jornada 2 exige o location). */
  locationId: number;
  devedor: EfiDebtor;
  /** Valor da recorrência em centavos (ex.: 15700 => "157.00"). */
  valorRecCents: number;
  /** Data da primeira cobrança, "AAAA-MM-DD". */
  dataInicial: string;
  dataFinal?: string;
  /** Padrão "MENSAL". */
  periodicidade?: string;
  contrato?: string;
  objeto?: string;
  /** Política de retentativa só é enviada quando o chamador decide (NAO_PERMITE, PERMITE_3R_7D...). */
  politicaRetentativa?: string;
}
export interface EfiChargeInput {
  idRec: string;
  /** Valor original da cobrança em centavos (ex.: 15700 => "157.00"). */
  originalCents: number;
  /** "AAAA-MM-DD". */
  dataDeVencimento: string;
  infoAdicional?: string;
  ajusteDiaUtil?: boolean;
  /** Endereço do devedor (cep, cidade, logradouro, uf) — opcional na API. */
  devedor?: Record<string, unknown>;
}
export interface EfiLocation { id: number; location: string; }
export interface EfiRecurrenceResult { idRec: string; status?: string; payload: Record<string, unknown>; }
export interface EfiChargeResult { txid: string; status?: string; payload: Record<string, unknown>; }

export interface EfiPixAutomaticOptions {
  credentialsEncrypted: string;
  encryptionKey: string;
  environment?: "sandbox" | "production";
  /** Injetável apenas para testes — produção usa https.request com pfx abaixo. */
  transport?: EfiTransport;
}

interface EfiCredentials { clientId: string; clientSecret: string; certificateP12Base64: string; certificatePassphrase?: string; }

const REQUEST_TIMEOUT_MS = 30_000;
/** Renova o token 60s antes do expires_in declarado pelo OAuth. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
/** txid do PIX (BCB): alfanumérico, até 35 caracteres. */
const TXID_PATTERN = /^[a-zA-Z0-9]{1,35}$/;

/** Efí/BRL espera valores com 2 decimais em string ("157.00"). */
function brl(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error("Efi Pix amount must be a non-negative integer number of cents");
  return (cents / 100).toFixed(2);
}
function str(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }

function defaultTransport(host: string, credentials: EfiCredentials): EfiTransport {
  // Um único agente mTLS (keepAlive) serve OAuth e API: mesma conexão TLS
  // reutilizada por todas as chamadas da instância.
  const agent = new https.Agent({
    pfx: Buffer.from(credentials.certificateP12Base64, "base64"),
    passphrase: credentials.certificatePassphrase,
    keepAlive: true,
    maxSockets: 1,
  });
  return async (request) => await new Promise<EfiTransportResponse>((resolve, reject) => {
    const req = https.request(
      // Accept-Encoding: identity — a API comprime >=1000B sem isso e o
      // Content-Length some (docs de credenciais da Efí).
      { host, method: request.method, path: request.path, agent, timeout: REQUEST_TIMEOUT_MS, headers: { Accept: "application/json", "Accept-Encoding": "identity", ...request.headers } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error("Efi Pix API request timed out")));
    req.on("error", reject);
    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
}

export class EfiPixAutomaticClient {
  private readonly environment: "sandbox" | "production";
  private transportImpl: EfiTransport | undefined;
  /** Token OAuth2 somente em memória, com expiração antecipada; nunca logado nem retornado. */
  private token?: { value: string; expiresAt: number };

  constructor(private readonly options: EfiPixAutomaticOptions) {
    this.environment = options.environment ?? "sandbox";
  }

  private credentials(): EfiCredentials {
    const raw = decryptCredentials<Record<string, unknown>>(this.options.credentialsEncrypted, this.options.encryptionKey);
    const credentials: EfiCredentials = {
      clientId: str(raw.clientId) ?? "",
      clientSecret: str(raw.clientSecret) ?? "",
      certificateP12Base64: str(raw.certificateP12Base64) ?? "",
      certificatePassphrase: str(raw.certificatePassphrase),
    };
    if (!credentials.clientId || !credentials.clientSecret || !credentials.certificateP12Base64) {
      // Mensagem lista apenas NOMES de campos, nunca valores.
      throw new Error("Efi Pix credentials are not configured (clientId, clientSecret, certificateP12Base64)");
    }
    return credentials;
  }

  private transport(): EfiTransport {
    return (this.transportImpl ??= this.options.transport ?? defaultTransport(EFI_PIX_HOSTS[this.environment], this.credentials()));
  }

  private async send(request: EfiTransportRequest): Promise<{ statusCode: number; json: unknown }> {
    let response: EfiTransportResponse;
    try {
      response = await this.transport()(request);
    } catch (error) {
      // Erro de transporte (rede/TLS/timeout): mensagem genérica, sem corpo/token.
      throw new Error("Efi Pix API request failed", { cause: error });
    }
    let json: unknown;
    try {
      json = JSON.parse(response.text) as unknown;
    } catch {
      throw new Error(`Efi Pix API error (${response.statusCode})`);
    }
    return { statusCode: response.statusCode, json };
  }

  private async ensureToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const credentials = this.credentials();
    const { statusCode, json } = await this.send({
      method: "POST",
      path: "/oauth/token",
      body: JSON.stringify({ grant_type: "client_credentials" }),
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
    });
    const payload = (json ?? {}) as Record<string, unknown>;
    const accessToken = str(payload.access_token);
    if (statusCode !== 200 || !accessToken) throw new Error(`Efi Pix API error (${statusCode})`);
    const seconds = typeof payload.expires_in === "number" && payload.expires_in > 60 ? payload.expires_in : 0;
    this.token = { value: accessToken, expiresAt: Date.now() + seconds * 1000 - TOKEN_EXPIRY_MARGIN_MS };
    return accessToken;
  }

  private async request(method: EfiTransportRequest["method"], path: string, body?: unknown): Promise<unknown> {
    const send = (token: string) => this.send({
      method,
      path,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
    });
    let result = await send(await this.ensureToken());
    if (result.statusCode === 401) {
      // Token revogado/invalidado no servidor antes do expires_in: renova uma vez e repete.
      this.token = undefined;
      result = await send(await this.ensureToken());
    }
    if (result.statusCode < 200 || result.statusCode > 299) throw new Error(`Efi Pix API error (${result.statusCode})`);
    return result.json;
  }

  private txid(txid: string): string {
    if (!TXID_PATTERN.test(txid)) throw new Error("Efi Pix txid must be alphanumeric with up to 35 characters");
    return encodeURIComponent(txid);
  }

  async createLocation(): Promise<EfiLocation> {
    const payload = (await this.request("POST", "/v2/locrec")) as Record<string, unknown>;
    return { id: payload.id as number, location: payload.location as string };
  }

  async createRecurrence(input: EfiRecurrenceInput): Promise<EfiRecurrenceResult> {
    if (!input.devedor.cpf && !input.devedor.cnpj) throw new Error("Efi Pix recurrence requires devedor cpf or cnpj");
    const devedor: Record<string, unknown> = { nome: input.devedor.nome };
    if (input.devedor.cpf) devedor.cpf = input.devedor.cpf;
    if (input.devedor.cnpj) devedor.cnpj = input.devedor.cnpj;
    const payload = (await this.request("POST", "/v2/rec", {
      vinculo: {
        ...(input.contrato === undefined ? {} : { contrato: input.contrato }),
        devedor,
        ...(input.objeto === undefined ? {} : { objeto: input.objeto }),
      },
      calendario: {
        dataInicial: input.dataInicial,
        ...(input.dataFinal === undefined ? {} : { dataFinal: input.dataFinal }),
        periodicidade: input.periodicidade ?? "MENSAL",
      },
      valor: { valorRec: brl(input.valorRecCents) },
      ...(input.politicaRetentativa === undefined ? {} : { politicaRetentativa: input.politicaRetentativa }),
      loc: input.locationId,
    })) as Record<string, unknown>;
    return { idRec: str(payload.idRec) ?? "", status: str(payload.status), payload };
  }

  async getRecurrence(idRec: string): Promise<EfiRecurrenceResult & { pixCopiaECola?: string }> {
    const payload = (await this.request("GET", `/v2/rec/${encodeURIComponent(idRec)}`)) as Record<string, unknown>;
    const dadosQR = payload.dadosQR as Record<string, unknown> | undefined;
    return {
      idRec: str(payload.idRec) ?? idRec,
      status: str(payload.status),
      pixCopiaECola: str(dadosQR?.pixCopiaECola),
      payload,
    };
  }

  async createCharge(txid: string, input: EfiChargeInput): Promise<EfiChargeResult> {
    const payload = (await this.request("PUT", `/v2/cobr/${this.txid(txid)}`, {
      idRec: input.idRec,
      ...(input.infoAdicional === undefined ? {} : { infoAdicional: input.infoAdicional }),
      calendario: { dataDeVencimento: input.dataDeVencimento },
      valor: { original: brl(input.originalCents) },
      ...(input.ajusteDiaUtil === undefined ? {} : { ajusteDiaUtil: input.ajusteDiaUtil }),
      ...(input.devedor === undefined ? {} : { devedor: input.devedor }),
    })) as Record<string, unknown>;
    return { txid: str(payload.txid) ?? txid, status: str(payload.status), payload };
  }

  async getCharge(txid: string): Promise<EfiChargeResult> {
    const payload = (await this.request("GET", `/v2/cobr/${this.txid(txid)}`)) as Record<string, unknown>;
    return { txid: str(payload.txid) ?? txid, status: str(payload.status), payload };
  }

  /**
   * GET /v2/pix/:e2eId (escopo pix.read) — Pix recebido com `devolucoes[]`
   * (status EM_PROCESSAMENTO | DEVOLVIDO | NAO_REALIZADO, docs "Gestão de Pix").
   */
  async getPix(e2eId: string): Promise<Record<string, unknown>> {
    if (!/^E[0-9A-Za-z]{31}$/.test(e2eId)) throw new Error("endToEndId inválido");
    return (await this.request("GET", `/v2/pix/${e2eId}`)) as Record<string, unknown>;
  }

  async cancelCharge(txid: string): Promise<EfiChargeResult> {
    const payload = (await this.request("PATCH", `/v2/cobr/${this.txid(txid)}`, { status: "CANCELADA" })) as Record<string, unknown>;
    return { txid: str(payload.txid) ?? txid, status: str(payload.status), payload };
  }
}
