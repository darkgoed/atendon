"use client";

import { SettingsDestinationAccess } from "@/app/configuracoes/settings-destination-access";
import { AgentSettingsContent } from "@/app/agente/settings-content";

export default function ConfiguracoesAgentePage() {
  return (
    <SettingsDestinationAccess requireRootWorkspace>
      <AgentSettingsContent />
    </SettingsDestinationAccess>
  );
}
