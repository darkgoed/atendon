"use client";

import { SettingsDestinationAccess } from "@/app/configuracoes/settings-destination-access";
import { WorkspaceMembersContent } from "@/app/workspace/members/content";

export default function ConfiguracoesMembrosPage() {
  return (
    <SettingsDestinationAccess required={['members.read']}>
      <WorkspaceMembersContent />
    </SettingsDestinationAccess>
  );
}
