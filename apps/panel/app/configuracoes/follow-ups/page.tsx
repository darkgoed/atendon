"use client";

import { SettingsDestinationAccess } from "@/app/configuracoes/settings-destination-access";
import { FollowUpsBody } from "@/app/follow-ups/follow-ups-content";

export default function ConfiguracoesFollowUpsPage() {
  return (
    <SettingsDestinationAccess requireRootWorkspace>
      <FollowUpsBody />
    </SettingsDestinationAccess>
  );
}
