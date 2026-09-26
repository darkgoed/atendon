"use client";

import { SettingsDestinationAccess } from "@/app/configuracoes/settings-destination-access";
import { HumanizationSettingsContent } from "@/app/humanizacao/settings-content";

export default function ConfiguracoesHumanizacaoPage() {
  return (
    <SettingsDestinationAccess requireRootWorkspace>
      <HumanizationSettingsContent />
    </SettingsDestinationAccess>
  );
}
