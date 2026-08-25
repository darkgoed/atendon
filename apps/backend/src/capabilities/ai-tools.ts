import type { CapabilityKey } from "../modules/operations/feature-flags.js";

const TOOL_CAPABILITIES: Readonly<Record<string, CapabilityKey>> = {
  consultar_categorias: "leads_v1",
  consultar_parceiros: "leads_v1",
  registrar_lead: "leads_v1",
  qualificar_lead: "leads_v1",
  enviar_proposta_parceiro: "leads_v1",
  atualizar_status_lead: "leads_v1",
  consultar_unidades: "appointments_v1",
  verificar_horarios: "appointments_v1",
  agendar_visita: "appointments_v1",
  reagendar_visita: "appointments_v1",
  cancelar_visita: "appointments_v1",
  consultar_agendas: "appointments_v1",
  verificar_horarios_reuniao: "appointments_v1",
  agendar_reuniao: "appointments_v1",
  reagendar_reuniao: "appointments_v1",
  cancelar_reuniao: "appointments_v1"
};

export function capabilityForAiTool(name: string): CapabilityKey | undefined {
  return TOOL_CAPABILITIES[name];
}

export async function filterAiToolsByCapabilities(
  names: readonly string[],
  enabled: (key: CapabilityKey) => Promise<boolean>
): Promise<string[]> {
  const required = [...new Set(names.flatMap((name) => {
    const capability = capabilityForAiTool(name);
    return capability ? [capability] : [];
  }))];
  const decisions = new Map<CapabilityKey, boolean>();
  await Promise.all(required.map(async (key) => {
    decisions.set(key, await enabled(key));
  }));
  return names.filter((name) => {
    const capability = capabilityForAiTool(name);
    return !capability || decisions.get(capability) === true;
  });
}
