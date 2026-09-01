import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import type { LookupFunction } from "node:net";

export const OUTBOUND_URL_NOT_PUBLIC = "OUTBOUND_URL_NOT_PUBLIC";
export class OutboundUrlError extends Error { readonly code = OUTBOUND_URL_NOT_PUBLIC; }

const nonPublicIpv4 = new net.BlockList();
for (const range of [
  ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4]
] as const) nonPublicIpv4.addSubnet(range[0], range[1], "ipv4");
const nonPublicIpv6 = new net.BlockList();
for (const range of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001:db8::", 32], ["2001:10::", 28], ["2001:20::", 28], ["2001:2::", 48],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]
] as const) nonPublicIpv6.addSubnet(range[0], range[1], "ipv6");

function publicIp(address: string): boolean {
  const normalized = address.toLowerCase().split("%", 1)[0];
  const family = net.isIP(normalized);
  if (family === 4 && Number(normalized.split(".", 1)[0]) === 0) return false;
  return family === 4 ? !nonPublicIpv4.check(normalized, "ipv4") :
    family === 6 ? !nonPublicIpv6.check(normalized, "ipv6") : false;
}

export function isPublicHttpsUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    return url.protocol === "https:" && !url.username && !url.password && !!hostname &&
      !["localhost", "localhost.localdomain"].includes(hostname.toLowerCase()) &&
      (net.isIP(hostname) === 0 || publicIp(hostname));
  }  catch { return false; }
}

export type LookupAll = (hostname: string, options: { all: true }) => Promise<Array<{ address: string; family: number }>>;
const systemLookup: LookupAll = (hostname, options) => new Promise((resolve, reject) => dns.lookup(hostname, options, (error, addresses) => error ? reject(error) : resolve(addresses)));

export async function resolvePublicHttpsUrl(raw: string, lookup: LookupAll = systemLookup): Promise<URL> {
  if (!isPublicHttpsUrl(raw)) throw new OutboundUrlError("Endpoint must be public HTTPS");
  const url = new URL(raw);
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    throw new OutboundUrlError("Endpoint DNS lookup failed");
  }
  if (!addresses.length || addresses.some(({ address }) => !publicIp(address))) throw new OutboundUrlError("Endpoint must resolve publicly");
  return url;
}

export function publicHttpsAgent(lookup: LookupAll = systemLookup): https.Agent {
  const controlled: LookupFunction = (hostname, _options, callback) => {
    lookup(hostname, { all: true }).then((addresses) => {
      if (!addresses.length || addresses.some(({ address }) => !publicIp(address))) {
        (callback as unknown as (error: Error) => void)(new OutboundUrlError("Endpoint must resolve publicly"));
        return;
      }
      const address = addresses[0];
      callback(null, address.address, address.family);
    }).catch(() => (callback as unknown as (error: Error) => void)(new OutboundUrlError("Endpoint DNS lookup failed")));
  };
  return new https.Agent({ lookup: controlled });
}
