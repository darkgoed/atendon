"use client";

import { SettingsDestinationAccess } from "@/app/configuracoes/settings-destination-access";
import { WorkspaceRolesContent } from "@/app/workspace/roles/content";

export default function ConfiguracoesFuncoesPage() {
  return (
    <SettingsDestinationAccess requireRootWorkspace>
      <WorkspaceRolesContent />
    </SettingsDestinationAccess>
  );
}
