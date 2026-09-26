"use client";

import { SettingsDestinationAccess } from "@/app/configuracoes/settings-destination-access";
import { UsoBody } from "@/app/uso/uso-content";

export default function ConfiguracoesUsoPage() {
  return (
    <SettingsDestinationAccess required={['usage.read']}>
      <UsoBody />
    </SettingsDestinationAccess>
  );
}
