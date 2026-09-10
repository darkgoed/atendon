import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";

afterEach(() => vi.unstubAllGlobals());

describe("panel API client", () => {
  it("does not attach a JSON content type to GET requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api<{ ok: boolean }>("/health")).resolves.toEqual({ ok: true });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).has("Content-Type")).toBe(false);
    expect(init.credentials).toBe("include");
  });

  it("accepts an empty 204 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(api("/empty")).resolves.toBeUndefined();
  });

  it("preserves JSON and plain-text error messages", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "Erro conhecido" }, { status: 400 }))
      .mockResolvedValueOnce(new Response("Serviço indisponível", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(api("/json-error")).rejects.toThrow("Erro conhecido");
    await expect(api("/text-error")).rejects.toThrow("Serviço indisponível");
  });

  it("does not expose an HTML error document as a user-facing message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "<!doctype html><html><body>internal proxy details</body></html>",
      { status: 502, headers: { "content-type": "text/html" } }
    )));

    await expect(api("/html-error")).rejects.toThrow("Falha na requisição (502)");
  });

  it("can suppress the global toast for an optional request", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { location: { pathname: "/conexao", href: "" }, dispatchEvent });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Not Found", {
      status: 404,
      headers: { "content-type": "text/plain" }
    })));

    await expect(api("/optional", undefined, { reportErrors: false })).rejects.toThrow("Not Found");
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it("redirects a session with a required password change to the dedicated page", async () => {
    const location = { pathname: "/", href: "" };
    vi.stubGlobal("window", { location, dispatchEvent: vi.fn() });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      { error: "Altere sua senha para continuar" },
      { status: 428 }
    )));

    await expect(api("/me")).rejects.toThrow("Altere sua senha para continuar");
    expect(location.href).toBe("/alterar-senha");
  });
});
