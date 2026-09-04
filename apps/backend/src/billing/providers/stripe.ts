import type { BillingProvider, WebhookResult } from "./types.js";
import { NotImplementedError } from "./types.js";

/**
 * Stub registrado (§14). Existe para provar que a arquitetura aceita um provider
 * novo sem tocar no domínio: basta implementar estes métodos.
 *
 * As assinaturas omitem os parâmetros porque nenhum é usado enquanto o provider
 * não estiver implementado — em TypeScript, um método que declara menos
 * parâmetros continua compatível com a interface.
 */
export class StripeProvider implements BillingProvider {
  createCustomer(): Promise<never> { throw new NotImplementedError(); }
  createSubscription(): Promise<never> { throw new NotImplementedError(); }
  cancelSubscription(): Promise<never> { throw new NotImplementedError(); }
  createPayment(): Promise<never> { throw new NotImplementedError(); }
  getPayment(): Promise<never> { throw new NotImplementedError(); }
  handleWebhook(): Promise<WebhookResult> { throw new NotImplementedError(); }
}
