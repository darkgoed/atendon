"use client";

import { Clock } from "@phosphor-icons/react";
import { Shell } from "@/components/shell";
import { AiFollowUpSettingsPanel } from "@/components/ai-follow-up-settings-panel";
import { AiStickerLibrary } from "@/components/ai-sticker-library";
import styles from "../channels-ai.module.css";

export default function FollowUpsPage() {
  return (
    <Shell><div className={`${styles.channelsAiPage} channels-ai-page`}>
      <header className="pagehead">
        <div>
          <div className="mono mb-3 flex items-center gap-2 type-overline"><Clock size={18} aria-hidden="true" />Automação da IA</div>
          <h1>Follow-ups</h1>
          <p>Configure a cadência e a biblioteca de mídias usadas nas mensagens automáticas.</p>
        </div>
      </header>
      <AiFollowUpSettingsPanel />
      <AiStickerLibrary />
    </div></Shell>
  );
}
