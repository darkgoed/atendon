"use client";

import { Clock } from "@/components/icons";
import { HelpHint } from "@/components/ui";
import { AiFollowUpSettingsPanel } from "@/components/ai-follow-up-settings-panel";
import { AiStickerLibrary } from "@/components/ai-sticker-library";
import styles from "../channels-ai.module.css";

export function FollowUpsBody() {
  return (
    <div className={`${styles.channelsAiPage} channels-ai-page`}>
      <header className="pagehead">
        <div>
          <div className="mono mb-3 flex items-center gap-2 type-caption uppercase tracking-[.16em] text-[var(--primary-text)]"><Clock size={18} />Automação da IA</div>
          <h1>Follow-ups <HelpHint label="Ajuda: Follow-ups">Mensagens que a IA envia sozinha para quem parou de responder. Aqui você define os intervalos das tentativas e o formato de cada envio.</HelpHint></h1>
        </div>
      </header>
      <AiFollowUpSettingsPanel />
      <AiStickerLibrary />
    </div>
  );
}
