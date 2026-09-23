"use client";

import { Clock } from "@/components/icons";
import { Shell } from "@/components/shell";
import { AiFollowUpSettingsPanel } from "@/components/ai-follow-up-settings-panel";
import { AiStickerLibrary } from "@/components/ai-sticker-library";
import styles from "../channels-ai.module.css";

export default function FollowUpsPage() {
  return (
    <Shell><div className={`${styles.channelsAiPage} channels-ai-page`}>
      <header className="pagehead">
        <div>
          <div className="mono mb-3 flex items-center gap-2 type-caption uppercase tracking-[.16em] text-[var(--primary-text)]"><Clock size={18} />Automação da IA</div>
          <h1>Follow-ups</h1>
        </div>
      </header>
      <AiFollowUpSettingsPanel />
      <AiStickerLibrary />
    </div></Shell>
  );
}
