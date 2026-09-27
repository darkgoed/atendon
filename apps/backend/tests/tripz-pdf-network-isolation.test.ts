import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportDocumentPdf } from "../src/modules/tripz-ai/document/pdf-chromium.js";
import type { ProposalSpec } from "@atendon/proposal-renderer";

// Segurança C2 (defesa em profundidade): o HTML da proposta é renderizado por
// um Chromium dentro do container da API. Qualquer requisição de rede a partir
// dele alcançaria a rede interna (metadados, Evolution, API) e o conteúdo
// voltaria impresso no PDF. No modo PDF tudo é inline (data:), então nenhuma
// requisição é legítima.
let server: Server;
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    hits.push(request.url ?? "");
    response.setHeader("content-type", "text/html");
    response.end("INTERNAL-SECRET-4242");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("PDF do Tripz isolado da rede", () => {
  it("HTML injetado com <iframe>/<img> para a rede interna não gera requisição", async () => {
    const port = (server.address() as AddressInfo).port;
    const html = `<!doctype html><html><body><h1>Proposta</h1>
      <img src="http://127.0.0.1:${port}/img.png">
      <iframe src="http://127.0.0.1:${port}/latest/meta-data/"></iframe></body></html>`;
    // O motor só usa o HTML; o spec não é lido na exportação.
    const pdf = await exportDocumentPdf({ spec: {} as ProposalSpec, html });
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(hits).toEqual([]);
  }, 60_000);
});
