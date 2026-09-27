"use client";

import { SettingsDestinationAccess } from "@/app/configuracoes/settings-destination-access";
import { Shell } from "@/components/shell";
import { WorkspaceRolesContent } from "./content";

export default function WorkspaceRolesPage() {
  return (
    <Shell>
      <SettingsDestinationAccess requireRootWorkspace>
        <WorkspaceRolesContent />
      </SettingsDestinationAccess>
    </Shell>
  );
}
