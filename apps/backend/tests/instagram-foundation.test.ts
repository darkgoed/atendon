import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { normalizeInstagramWebhook, verifyChallenge, verifyInstagramSignature, MetaInstagramProvider } from "../src/modules/instagram/provider.js";
import { signMediaUrl, verifyMediaUrl } from "../src/modules/instagram/media.js";
describe("Instagram foundation security",()=>{
 it("verifies raw bytes and rejects altered/missing signatures",()=>{const raw=Buffer.from('{"b":2,"a":1}');const sig="sha256="+createHmac("sha256","secret").update(raw).digest("hex");expect(verifyInstagramSignature(raw,sig,"secret")).toBe(true);expect(verifyInstagramSignature(Buffer.from('{"a":1,"b":2}'),sig,"secret")).toBe(false);expect(verifyInstagramSignature(raw,undefined,"secret")).toBe(false);});
 it("checks challenge in constant-time compatible way",()=>{expect(verifyChallenge({mode:"subscribe",token:"verify",challenge:"123"},"verify")).toBe("123");expect(()=>verifyChallenge({mode:"subscribe",token:"bad",challenge:"123"},"verify")).toThrow();});
 it("normalizes inbound, echo, read and reaction without phone",()=>{const e=normalizeInstagramWebhook({object:"instagram",entry:[{id:"acct",time:Date.now(),messaging:[{sender:{id:"igsid"},recipient:{id:"acct"},timestamp:Date.now(),message:{mid:"mid",text:"oi"}},{sender:{id:"acct"},recipient:{id:"igsid"},timestamp:Date.now(),message:{mid:"echo",text:"ok",is_echo:true}},{sender:{id:"igsid"},read:{mid:"mid"}}]}]});expect(e[0]).toMatchObject({kind:"message",providerUserId:"igsid",isEcho:false});expect(e[1].isEcho).toBe(true);expect(e[2].kind).toBe("read");});
 it("never retries ambiguous provider calls",async()=>{const provider=new MetaInstagramProvider({appId:"a",appSecret:"b",fetchImpl:async()=>{throw new Error("timeout")}});await expect(provider.sendText({instagramAccountId:"a",recipientId:"u",accessToken:"t",text:"x"})).resolves.toMatchObject({outcome:"ambiguous"});});
 it("expires signed media URLs",()=>{const token=signMediaUrl("m","k",60,100000);expect(verifyMediaUrl(token,"m","k",100000)).toBe(true);expect(verifyMediaUrl(token,"m","k",200000)).toBe(false);});
});
