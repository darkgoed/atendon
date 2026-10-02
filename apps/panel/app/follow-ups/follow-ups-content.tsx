"use client";

import { HelpHint } from "@/components/ui";
import { AiFollowUpSettingsPanel } from "@/components/ai-follow-up-settings-panel";
import { AiStickerLibrary } from "@/components/ai-sticker-library";
import styles from "../channels-ai.module.css";

export function FollowUpsBody() {
  return (
    <div className={`${styles.channelsAiPage} channels-ai-page`}>
      <header className="pagehead">
        <div>
          <h1><HelpHint content="Mensagens automáticas para quem parou de responder." description={<>Mensagens que a IA envia sozinha para quem parou de responder. Aqui você define os intervalos das tentativas e o formato de cada envio.</>}>Follow-ups</HelpHint></h1>
        </div>
      </header>
      <AiFollowUpSettingsPanel />
      <AiStickerLibrary />
    </div>
  );
}
