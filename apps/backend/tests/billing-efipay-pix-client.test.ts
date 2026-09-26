import { describe, expect, it } from "vitest";
import {
  EFI_PIX_HOSTS,
  EfiPixAutomaticClient,
  type EfiTransport,
  type EfiTransportRequest,
  type EfiTransportResponse,
} from "../src/billing/providers/efipay-pix-automatic.js";
import { encryptCredentials } from "../src/billing/providers/credentials.js";

const encryptionKey = "a".repeat(32);
const clientId = "efi-client-id";
const clientSecret = "efi-client-secret";
const accessToken = "efi-access-token";
const credentialsEncrypted = encryptCredentials(
  { clientId, clientSecret, certificateP12Base64: Buffer.from("fake-p12").toString("base64") },
  encryptionKey
);

function fakeTransport(respond: (request: EfiTransportRequest) => EfiTransportResponse) {
  const requests: EfiTransportRequest[] = [];
  const transport: EfiTransport = async (request) => {
    requests.push(request);
    return respond(request);
  };
  return { transport, requests };
}

/** Captura a rejeição como Error (falha o teste se a promise resolver). */
async function catchError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject");
}

function oauthResponse(expiresIn = 3600): EfiTransportResponse {
  return { statusCode: 200, text: JSON.stringify({ access_token: accessToken, token_type: "Bearer", expires_in: expiresIn, scope: "rec.write cobr.write payloadlocationrec.write" }) };
}

function bearer(request: EfiTransportRequest): string | undefined {
  const header = request.headers.Authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

/** OAuth fixo + resposta por path. */
function apiClient(api: (request: EfiTransportRequest) => EfiTransportResponse) {
  let oauthCalls = 0;
  const { transport, requests } = fakeTransport((request) => {
    if (request.path === "/oauth/token") {
      oauthCalls++;
      return oauthResponse();
    }
    return api(request);
  });
  const client = new EfiPixAutomaticClient({ credentialsEncrypted, encryptionKey, transport });
  return { client, requests, oauthCalls: () => oauthCalls };
}

describe("Efí Pix Automático client", () => {
  it("usa hosts fixos (produção/homologação), sem URL configurável", () => {
    expect(EFI_PIX_HOSTS.production).toBe("pix.api.efipay.com.br");
    expect(EFI_PIX_HOSTS.sandbox).toBe("pix-h.api.efipay.com.br");
  });

  it("autentica via POST /oauth/token com Basic e grant_type client_credentials, reusa o token em memória", async () => {
    const { transport, requests } = fakeTransport((request) => (request.path === "/oauth/token" ? oauthResponse() : { statusCode: 201, text: JSON.stringify({ id: 1, location: "loc" }) }));
    const client = new EfiPixAutomaticClient({ credentialsEncrypted, encryptionKey, transport });
    await client.createLocation();
    await client.createLocation();

    const oauth = requests.filter((request) => request.path === "/oauth/token");
    expect(oauth).toHaveLength(1);
    expect(oauth[0].method).toBe("POST");
    expect(oauth[0].headers.Authorization).toBe(`Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`);
    expect(oauth[0].headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(oauth[0].body ?? "")).toEqual({ grant_type: "client_credentials" });

    // Nenhuma chamada de API repete o OAuth; todas usam Bearer.
    const api = requests.filter((request) => request.path !== "/oauth/token");
    expect(api).toHaveLength(2);
    expect(api.map(bearer)).toEqual([accessToken, accessToken]);
  });

  it("renova o token quando expires_in entra na margem de segurança", async () => {
    let oauthCalls = 0;
    const { transport, requests } = fakeTransport((request) => {
      if (request.path === "/oauth/token") {
        oauthCalls++;
        // 60s => expira imediatamente (margem de segurança de 60s).
        return oauthResponse(60);
      }
      return { statusCode: 201, text: JSON.stringify({ id: 1, location: "loc" }) };
    });
    const client = new EfiPixAutomaticClient({ credentialsEncrypted, encryptionKey, transport });
    await client.createLocation();
    await client.createLocation();
    expect(oauthCalls).toBe(2);
    expect(requests.filter((request) => request.path !== "/oauth/token")).toHaveLength(2);
  });

  it("renova o token e repete uma vez quando a API responde 401", async () => {
    let oauthCalls = 0;
    let apiCalls = 0;
    const { transport, requests } = fakeTransport((request) => {
      if (request.path === "/oauth/token") {
        oauthCalls++;
        return oauthResponse();
      }
      apiCalls++;
      if (apiCalls === 1) return { statusCode: 401, text: JSON.stringify({ title: "token_invalido" }) };
      return { statusCode: 201, text: JSON.stringify({ id: 1, location: "loc" }) };
    });
    const client = new EfiPixAutomaticClient({ credentialsEncrypted, encryptionKey, transport });
    const location = await client.createLocation();
    expect(location.id).toBe(1);
    expect(oauthCalls).toBe(2);
    expect(apiCalls).toBe(2);
    expect(requests.filter((request) => request.path !== "/oauth/token")).toHaveLength(2);
  });

  it("createLocation faz POST /v2/locrec sem corpo e devolve id/location", async () => {
    const { client, requests } = apiClient(() => ({ statusCode: 201, text: JSON.stringify({ id: 12069, location: "pix.example.com/qr/v2/rec/abc", criacao: "2023-12-20T12:38:28.774Z" }) }));
    const location = await client.createLocation();

    expect(requests).toHaveLength(2); // oauth + locrec
    expect(requests[1]).toMatchObject({ method: "POST", path: "/v2/locrec" });
    expect(requests[1].body).toBeUndefined();
    expect(bearer(requests[1])).toBe(accessToken);
    expect(location).toEqual({ id: 12069, location: "pix.example.com/qr/v2/rec/abc" });
  });

  it("createRecurrence (jornada 2) faz POST /v2/rec com loc, MENSAL, valorRec, devedor e dataInicial", async () => {
    const { client, requests } = apiClient((request) => {
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/v2/rec");
      return { statusCode: 201, text: JSON.stringify({ idRec: "RN1234567820240115abcdefghijk", status: "CRIADA", valor: { valorRec: "157.00" } }) };
    });
    const recurrence = await client.createRecurrence({
      locationId: 12069,
      devedor: { nome: "Fulano de Tal", cpf: "45164632481" },
      valorRecCents: 15700,
      dataInicial: "2026-10-01",
      contrato: "63100862",
      objeto: "Serviço de Streaming de Música.",
      politicaRetentativa: "NAO_PERMITE",
    });

    const rec = JSON.parse(requests[1].body ?? "{}") as Record<string, unknown>;
    expect(rec.loc).toBe(12069);
    expect(rec.calendario).toEqual({ dataInicial: "2026-10-01", periodicidade: "MENSAL" });
    expect(rec.valor).toEqual({ valorRec: "157.00" });
    expect(rec.vinculo).toEqual({ contrato: "63100862", devedor: { nome: "Fulano de Tal", cpf: "45164632481" }, objeto: "Serviço de Streaming de Música." });
    expect(rec.politicaRetentativa).toBe("NAO_PERMITE");
    expect(recurrence.idRec).toBe("RN1234567820240115abcdefghijk");
    expect(recurrence.status).toBe("CRIADA");
  });

  it("createRecurrence exige devedor com cpf ou cnpj", async () => {
    const { client, requests } = apiClient(() => ({ statusCode: 201, text: "{}" }));
    await expect(client.createRecurrence({ locationId: 1, devedor: { nome: "Fulano" }, valorRecCents: 15700, dataInicial: "2026-10-01" })).rejects.toThrow("cpf or cnpj");
    expect(requests.filter((request) => request.path === "/v2/rec")).toHaveLength(0);
  });

  it("getRecurrence faz GET /v2/rec/:idRec e extrai dadosQR.pixCopiaECola", async () => {
    const copiaECola = "00020126180014br.gov.bcb.pix5204000053039865802BR5913Fulano de Tal";
    const { client } = apiClient((request) => {
      expect(request.method).toBe("GET");
      expect(request.path).toBe("/v2/rec/RN1234567820240115abcdefghijk");
      return { statusCode: 200, text: JSON.stringify({ idRec: "RN1234567820240115abcdefghijk", status: "APROVADA", dadosQR: { jornada: "JORNADA_2", pixCopiaECola: copiaECola } }) };
    });
    const recurrence = await client.getRecurrence("RN1234567820240115abcdefghijk");
    expect(recurrence.pixCopiaECola).toBe(copiaECola);
    expect(recurrence.status).toBe("APROVADA");
  });

  it("createCharge faz PUT /v2/cobr/:txid com idRec, calendário e valor original", async () => {
    const { client, requests } = apiClient(() => ({ statusCode: 201, text: JSON.stringify({ txid: "3136957d93134f2184b369e8f1c0729d", idRec: "RN1234567820240115abcdefghijk", status: "CRIADA", valor: { original: "157.00" } }) }));
    const charge = await client.createCharge("3136957d93134f2184b369e8f1c0729d", {
      idRec: "RN1234567820240115abcdefghijk",
      originalCents: 15700,
      dataDeVencimento: "2026-10-15",
      infoAdicional: "Fatura mensal",
      ajusteDiaUtil: true,
    });

    expect(requests[1]).toMatchObject({ method: "PUT", path: "/v2/cobr/3136957d93134f2184b369e8f1c0729d" });
    const body = JSON.parse(requests[1].body ?? "{}") as Record<string, unknown>;
    expect(body.idRec).toBe("RN1234567820240115abcdefghijk");
    expect(body.calendario).toEqual({ dataDeVencimento: "2026-10-15" });
    expect(body.valor).toEqual({ original: "157.00" });
    expect(body.infoAdicional).toBe("Fatura mensal");
    expect(body.ajusteDiaUtil).toBe(true);
    expect(charge.txid).toBe("3136957d93134f2184b369e8f1c0729d");
    expect(charge.status).toBe("CRIADA");
  });

  it("getCharge faz GET /v2/cobr/:txid", async () => {
    const { client } = apiClient((request) => {
      expect(request.method).toBe("GET");
      expect(request.path).toBe("/v2/cobr/3136957d93134f2184b369e8f1c0729d");
      return { statusCode: 200, text: JSON.stringify({ txid: "3136957d93134f2184b369e8f1c0729d", status: "ATIVA", valor: { original: "157.00" } }) };
    });
    const charge = await client.getCharge("3136957d93134f2184b369e8f1c0729d");
    expect(charge.status).toBe("ATIVA");
  });

  it("cancelCharge faz PATCH /v2/cobr/:txid com status CANCELADA", async () => {
    const { client, requests } = apiClient((request) => {
      expect(request.method).toBe("PATCH");
      expect(request.path).toBe("/v2/cobr/3136957d93134f2184b369e8f1c0729d");
      return { statusCode: 200, text: JSON.stringify({ txid: "3136957d93134f2184b369e8f1c0729d", status: "CANCELADA" }) };
    });
    const charge = await client.cancelCharge("3136957d93134f2184b369e8f1c0729d");
    expect(JSON.parse(requests[1].body ?? "{}")).toEqual({ status: "CANCELADA" });
    expect(charge.status).toBe("CANCELADA");
  });

  it("rejeita txid fora do padrão BCB antes de chamar a API", async () => {
    const { client, requests } = apiClient(() => ({ statusCode: 200, text: "{}" }));
    await expect(client.createCharge("txid com espaço", { idRec: "rec", originalCents: 100, dataDeVencimento: "2026-10-15" })).rejects.toThrow("txid must be alphanumeric");
    expect(requests.filter((request) => request.path.startsWith("/v2/"))).toHaveLength(0);
  });

  it("erros de API são genéricos: sem corpo, sem detalhe e sem token", async () => {
    const { client, requests } = apiClient(() => ({ statusCode: 400, text: JSON.stringify({ title: "Operação inválida.", detail: `CORPO SENSÍVEL ${accessToken}` }) }));
    const error = await catchError(client.createLocation());
    expect(error.message).toBe("Efi Pix API error (400)");
    expect(error.message).not.toContain("CORPO SENSÍVEL");
    expect(error.message).not.toContain(accessToken);
    expect(error.message).not.toContain(clientSecret);
    expect(requests.filter((request) => request.path !== "/oauth/token")).toHaveLength(1);
  });

  it("falhas de transporte viram erro genérico", async () => {
    const transport: EfiTransport = async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:443");
    };
    const client = new EfiPixAutomaticClient({ credentialsEncrypted, encryptionKey, transport });
    const error = await catchError(client.createLocation());
    expect(error.message).toBe("Efi Pix API request failed");
  });

  it("recusa credenciais incompletas sem chamar a API", async () => {
    const client = new EfiPixAutomaticClient({
      credentialsEncrypted: encryptCredentials({ clientId: "only-id" }, encryptionKey),
      encryptionKey,
      transport: async () => {
        throw new Error("transport should not be reached");
      },
    });
    await expect(client.createLocation()).rejects.toThrow("Efi Pix credentials are not configured");
  });

  it("nenhum resultado devolve segredo ou token", async () => {
    const { client } = apiClient(() => ({ statusCode: 201, text: JSON.stringify({ id: 12069, location: "loc", status: "CRIADA" }) }));
    const results = [
      await client.createLocation(),
      await client.createRecurrence({ locationId: 12069, devedor: { nome: "Fulano", cpf: "45164632481" }, valorRecCents: 15700, dataInicial: "2026-10-01" }),
      await client.getRecurrence("RN1234567820240115abcdefghijk"),
      await client.createCharge("3136957d93134f2184b369e8f1c0729d", { idRec: "RN1234567820240115abcdefghijk", originalCents: 15700, dataDeVencimento: "2026-10-15" }),
      await client.getCharge("3136957d93134f2184b369e8f1c0729d"),
      await client.cancelCharge("3136957d93134f2184b369e8f1c0729d"),
    ];
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain(clientSecret);
    expect(serialized).not.toContain(accessToken);
    expect(serialized).not.toContain("certificateP12Base64");
  });
});
