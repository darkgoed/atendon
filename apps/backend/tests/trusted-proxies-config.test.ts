import { describe, expect, it } from "vitest";
import { parseTrustedProxies } from "../src/config.js";

// Revisão T1: confiar em toda rede privada deixa outro container da rede
// Docker compartilhada escolher o próprio IP nos limites por IP. O padrão
// segue loopback+privadas; a implantação pode restringir aos IPs da borda.
describe("TRUSTED_PROXIES", () => {
  it("keeps loopback and private networks as the default", () => {
    expect(parseTrustedProxies(undefined)).toEqual(["loopback", "uniquelocal"]);
    expect(parseTrustedProxies("  ")).toEqual(["loopback", "uniquelocal"]);
  });

  it("accepts the edge's own addresses and CIDRs to narrow the trust", () => {
    expect(parseTrustedProxies("loopback, 10.0.1.7, 172.18.0.0/16, fd00::1")).toEqual(["loopback", "10.0.1.7", "172.18.0.0/16", "fd00::1"]);
  });

  it("refuses to boot with an unrecognised entry instead of silently trusting nothing or everything", () => {
    expect(() => parseTrustedProxies("loopback,everyone")).toThrow(/TRUSTED_PROXIES/);
    expect(() => parseTrustedProxies(",")).toThrow(/TRUSTED_PROXIES/);
  });
});
