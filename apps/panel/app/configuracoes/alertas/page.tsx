"use client";

import { SettingsDestinationAccess } from "@/app/configuracoes/settings-destination-access";
import { AlertasBody } from "@/app/alertas/alertas-content";

export default function ConfiguracoesAlertasPage() {
  return (
    <SettingsDestinationAccess requireRootWorkspace>
      <AlertasBody />
    </SettingsDestinationAccess>
  );
}
