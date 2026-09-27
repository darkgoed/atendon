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
          <h1>Follow-ups <HelpHint label="Ajuda: Follow-ups">Mensagens que a IA envia sozinha para quem parou de responder. Aqui você define os intervalos das tentativas e o formato de cada envio.</HelpHint></h1>
        </div>
      </header>
      <AiFollowUpSettingsPanel />
      <AiStickerLibrary />
    </div>
  );
}
