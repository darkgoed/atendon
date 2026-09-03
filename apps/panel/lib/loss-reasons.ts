"use client";

import useSWR from "swr";
import { api } from "@/lib/api";

/**
 * Motivos de perda/desqualificação vêm do catálogo do tenant
 * (`GET /organization/loss-reasons`). Antes eram uma lista fixa duplicada em
 * três formulários do painel, o que impedia cada cliente de ter o seu próprio
 * vocabulário comercial.
 */
export type LossReasonOption = {
  id: string;
  chave: string;
  rotulo: string;
  posicao: number;
  exige_observacao: boolean;
  sistema: boolean;
  arquivado_em?: string | null;
};

type LossReasonsResponse = { motivos: LossReasonOption[] };

const fetcher = <T,>(url: string) => api<T>(url);

export function useLossReasons() {
  const { data, error, isLoading } = useSWR<LossReasonsResponse>("/organization/loss-reasons", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 60_000
  });
  return {
    reasons: data?.motivos ?? [],
    loading: isLoading,
    error: error ? "Não foi possível carregar os motivos." : ""
  };
}

export function lossReasonRequiresNote(reasons: LossReasonOption[], key: string): boolean {
  return reasons.some((reason) => reason.chave === key && reason.exige_observacao);
}

export function lossReasonLabel(reasons: LossReasonOption[], key?: string | null): string {
  if (!key) return "";
  return reasons.find((reason) => reason.chave === key)?.rotulo
    ?? key.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}
