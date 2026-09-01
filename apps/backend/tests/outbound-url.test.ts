import { describe, expect, it } from "vitest";
import https from "node:https";
import { isPublicHttpsUrl, publicHttpsAgent, resolvePublicHttpsUrl } from "../src/security/outbound-url.js";

describe("public HTTPS outbound URL policy", () => {
  it.each([
    "http://example.com/push", "https://user:pass@example.com/push", "https://localhost/push",
    "https://127.0.0.1/push", "https://10.0.0.1/push", "https://169.254.1.1/push",
    "https://224.0.0.1/push", "https://[::1]/push", "https://[fc00::1]/push",
    "https://[fe80::1]/push", "https://[::ffff:127.0.0.1]/push", "https://[::ffff:10.0.0.1]/push",
    "https://[ff02::1]/push", "https://[::ffff:8.8.8.8]/push", "https://[::ffff:192.168.1.1]/push",
    ...["0.1.2.3", "10.1.2.3", "100.64.0.1", "127.1.2.3", "169.254.1.1", "172.16.0.1",
      "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.51.100.1",
      "203.0.113.1", "224.0.0.1", "240.0.0.1"].map((ip) => `https://${ip}/push`),
    ...["64:ff9b:1::1", "100::1", "2001:db8::1", "2001:10::1", "2001:20::1", "2001:2::1",
      "fc00::1", "fe80::1", "ff00::1"].map((ip) => `https://[${ip}]/push`)
  ])("rejects unsafe endpoint %s", (endpoint) => expect(isPublicHttpsUrl(endpoint)).toBe(false));

  it("accepts only syntactically valid HTTPS public candidates", () => {
    expect(isPublicHttpsUrl("https://push.example/subscription")).toBe(true);
    expect(isPublicHttpsUrl("not a url")).toBe(false);
  });

  it("rejects private answers and wraps DNS errors", async () => {
    await expect(resolvePublicHttpsUrl("https://push.example/subscription", async () => [
      { address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }
    ])).rejects.toMatchObject({ code: "OUTBOUND_URL_NOT_PUBLIC" });
    await expect(resolvePublicHttpsUrl("https://push.example", async () => { throw new Error("ENOTFOUND"); }))
      .rejects.toMatchObject({ code: "OUTBOUND_URL_NOT_PUBLIC" });
  });

  it("uses one validated lookup result for the actual connection", async () => {
    const seen: string[] = [];
    const agent = publicHttpsAgent(async (hostname: string) => { seen.push(hostname); return [{ address: "93.184.216.34", family: 4 }]; });
    const lookup = (agent.options as https.AgentOptions).lookup as NonNullable<https.AgentOptions["lookup"]>;
    await expect(new Promise((resolve, reject) => lookup("push.example", {}, (error, address, family) => error ? reject(error) : resolve({ address, family }))))
      .resolves.toEqual({ address: "93.184.216.34", family: 4 });
    expect(seen).toEqual(["push.example"]);
  });

  it("rejects any-private and DNS failure through the real agent callback", async () => {
    for (const resolver of [
      async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }],
      async () => { throw new Error("ENOTFOUND"); }
    ]) {
      const lookup = (publicHttpsAgent(resolver).options as https.AgentOptions).lookup as NonNullable<https.AgentOptions["lookup"]>;
      await expect(new Promise((resolve, reject) => lookup("push.example", {}, (error, address) => error ? reject(error) : resolve(address))))
        .rejects.toMatchObject({ code: "OUTBOUND_URL_NOT_PUBLIC" });
    }
  });

  it.each([["198.51.99.1", false], ["203.0.113.1", true], ["203.0.114.1", false], ["8.8.8.8", false], ["2001:4860:4860::8888", false]]) ("handles IPv4/IPv6 boundaries %s", async (address, blocked) => {
    const result = resolvePublicHttpsUrl("https://push.example", async () => [{ address, family: address.includes(":") ? 6 : 4 }]);
    if (blocked) await expect(result).rejects.toMatchObject({ code: "OUTBOUND_URL_NOT_PUBLIC" });
    else await expect(result).resolves.toBeDefined();
  });
});
