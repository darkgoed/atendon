import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Compõe className resolvendo conflitos de utilitários Tailwind (o último
 * vence). Usado pelos primitives do design system para que um `className`
 * vindo da chamada sobreponha o default do primitive em vez de duplicá-lo.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
