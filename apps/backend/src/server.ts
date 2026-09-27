import { config } from "./config.js";
import { buildApp } from "./app.js";

const app = buildApp();
if (config.CONTAINER_RUNTIME && !process.env.TRUSTED_PROXIES?.trim()) {
  // Padrão loopback,uniquelocal confia em qualquer container da rede Docker:
  // um vizinho pode forjar X-Forwarded-For e fugir dos limites por IP
  // (login/TOTP). Configure com os IPs/CIDRs da borda (painel + Traefik).
  app.log.warn({ trustedProxies: config.TRUSTED_PROXIES }, "TRUSTED_PROXIES não configurado: X-Forwarded-For aceito de qualquer IP privado");
}
await app.listen({ port: config.PORT, host: config.HOST });
