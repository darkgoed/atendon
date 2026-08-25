import { SignJWT } from "jose";

export interface JitsiTokenUser {
  id: string;
  name: string;
  email?: string;
}

export interface JitsiTokenOptions {
  appId: string;
  secret: string;
  publicUrl: string;
  roomName: string;
  role: "moderator" | "participant";
  user: JitsiTokenUser;
  now?: Date;
  ttlSeconds?: number;
}

export async function createJitsiToken(options: JitsiTokenOptions): Promise<string> {
  const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  const ttlSeconds = options.ttlSeconds ?? 2 * 60 * 60;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 24 * 60 * 60) {
    throw new Error("Jitsi token TTL must be between 60 seconds and 24 hours");
  }
  const moderator = options.role === "moderator";
  const domain = new URL(options.publicUrl).host;
  const contextUser: Record<string, unknown> = {
    id: options.user.id,
    name: options.user.name,
    affiliation: moderator ? "owner" : "member",
    moderator
  };
  if (options.user.email) contextUser.email = options.user.email;

  return new SignJWT({
    room: options.roomName,
    context: {
      user: contextUser,
      features: { recording: moderator }
    }
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(options.appId)
    .setAudience(options.appId)
    .setSubject(domain)
    .setIssuedAt(issuedAt)
    .setNotBefore(issuedAt - 5)
    .setExpirationTime(issuedAt + ttlSeconds)
    .sign(new TextEncoder().encode(options.secret));
}
