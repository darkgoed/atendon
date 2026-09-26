"use client";

import { SettingsDestinationAccess } from "@/app/configuracoes/settings-destination-access";
import { WorkspaceAuditContent } from "@/app/workspace/audit/content";

export default function ConfiguracoesAuditoriaPage() {
  return (
    <SettingsDestinationAccess required={['audit.read']}>
      <WorkspaceAuditContent />
    </SettingsDestinationAccess>
  );
}
