import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { describe, expect, it } from "vitest";
import { sendTransferNotification, type TransferRequestFactory } from "../src/modules/scheduling/service.js";

const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
type MockRequest = EventEmitter & { body?: string; end: (body: string) => void; destroy: (error: Error) => void };
type MockResponse = EventEmitter & { statusCode: number; resume: () => void };
type RequestCall = { url: URL; options: RequestOptions; req: MockRequest };

function requestMock(statusCode: number, body = ""): TransferRequestFactory & { last?: RequestCall } {
  const request = ((url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const req = new EventEmitter() as unknown as MockRequest;
    req.end = (sent: string) => {
      req.body = sent;
      const response = new EventEmitter() as unknown as MockResponse;
      response.statusCode = statusCode;
      response.resume = () => {};
      callback(response as unknown as IncomingMessage);
      if (body) response.emit("data", body);
      response.emit("end");
    };
    req.destroy = (error: Error) => req.emit("error", error);
    request.last = { url, options, req };
    return req as unknown as ClientRequest;
  }) as TransferRequestFactory & { last?: RequestCall };
  return request;
}

describe("transfer webhook", () => {
  it("validates before connecting and sends exactly JSON over HTTPS", async () => {
    const request = requestMock(204);
    const payload = { event: "transfer", id: "abc" };
    await expect(sendTransferNotification("https://hooks.example/transfer", payload, 1000, undefined, { lookup, request })).resolves.toBeUndefined();
    expect(request.last?.req.body).toBe(JSON.stringify(payload));
    expect(request.last?.options.headers).toEqual({ "content-type": "application/json" });
  });
  it.each([301, 302, 400, 404, 500])("fails for HTTP status %s", async (status) => {
    await expect(sendTransferNotification("https://hooks.example/x", {}, 1000, undefined, { lookup, request: requestMock(status) })).rejects.toThrow();
  });
  it("fails on timeout", async () => {
    const reqFactory: TransferRequestFactory = () => {
      const req = new EventEmitter() as unknown as MockRequest;
      req.end = () => queueMicrotask(() => req.emit("timeout"));
      req.destroy = (error: Error) => req.emit("error", error);
      return req as unknown as ClientRequest;
    };
    await expect(sendTransferNotification("https://hooks.example/x", {}, 1000, undefined, { lookup, request: reqFactory })).rejects.toThrow("timeout");
  });
  it("blocks private/DNS failures before request", async () => {
    for (const bad of [async () => [{ address: "192.168.1.1", family: 4 }], async () => { throw new Error("ENOTFOUND"); }]) {
      let connected = false;
      const request: TransferRequestFactory = () => {
        connected = true;
        throw new Error("request should not be called");
      };
      await expect(sendTransferNotification("https://hooks.example/x", {}, 1000, undefined, { lookup: bad, request })).rejects.toMatchObject({ code: "OUTBOUND_URL_NOT_PUBLIC" });
      expect(connected).toBe(false);
    }
  });
  it("adds verifiable HMAC only when a sufficiently long secret is supplied", async () => {
    const timestamp = 1_725_000_000_000;
    const payload = { ok: true };
    const request = requestMock(204);
    await sendTransferNotification("https://hooks.example/x", payload, 1000, "s".repeat(32), { lookup, request, clock: () => timestamp });
    const headers = request.last?.options.headers as Record<string, string | undefined>;
    const expected = createHmac("sha256", "s".repeat(32)).update(`${Math.floor(timestamp / 1000)}.${JSON.stringify(payload)}`).digest("hex");
    expect(headers["x-atendon-timestamp"]).toBe(String(Math.floor(timestamp / 1000)));
    expect(headers["x-atendon-signature"]).toBe(expected);
    const noSecret = requestMock(204);
    await sendTransferNotification("https://hooks.example/x", payload, 1000, undefined, { lookup, request: noSecret });
    expect((noSecret.last?.options.headers as Record<string, string | undefined>)["x-atendon-signature"]).toBeUndefined();
  });
});
