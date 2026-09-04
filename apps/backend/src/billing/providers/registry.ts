import type { BillingProvider } from "./types.js";
import { ManualPixProvider } from "./manual-pix.js";
import { MercadoPagoProvider, type MercadoPagoOptions } from "./mercadopago.js";
import { StripeProvider } from "./stripe.js";
import { PagBankProvider } from "./pagbank.js";
export const SUPPORTED_PROVIDER_CODES = ["manual_pix","mercadopago","stripe","pagbank"] as const;
export type ProviderCode = typeof SUPPORTED_PROVIDER_CODES[number];
export type ProviderFactoryOptions = { manualPix?: ConstructorParameters<typeof ManualPixProvider>[0]; mercadopago?: MercadoPagoOptions };
export function getProvider(code:string, options:ProviderFactoryOptions = {}): BillingProvider { switch(code){case "manual_pix": if(!options.manualPix) throw new Error("manual_pix configuration is not available"); return new ManualPixProvider(options.manualPix); case "mercadopago": if(!options.mercadopago) throw new Error("mercadopago credentials are not configured"); return new MercadoPagoProvider(options.mercadopago); case "stripe": return new StripeProvider(); case "pagbank": return new PagBankProvider(); default: throw new Error(`Unsupported billing provider: ${code}`);} }
