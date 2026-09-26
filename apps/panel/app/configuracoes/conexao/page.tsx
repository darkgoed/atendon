"use client";

import { SettingsDestinationAccess } from "@/app/configuracoes/settings-destination-access";
import { ConnectionSettingsContent } from "@/app/conexao/settings-content";

export default function ConfiguracoesConexaoPage() {
  return (
    <SettingsDestinationAccess required={['connection.read']}>
      <ConnectionSettingsContent />
    </SettingsDestinationAccess>
  );
}
