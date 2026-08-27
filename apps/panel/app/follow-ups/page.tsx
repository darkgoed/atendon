"use client";

import { Clock } from "@phosphor-icons/react";
import { Shell } from "@/components/shell";
import { AiFollowUpSettingsPanel } from "@/components/ai-follow-up-settings-panel";

export default function FollowUpsPage() {
  return (
    <Shell>
      <header className="pagehead">
        <div>
          <div className="mono mb-3 flex items-center gap-2 text-[10px] uppercase tracking-[.16em] text-[var(--accent-soft)]"><Clock size={18} />Automação da IA</div>
          <h1>Follow-ups</h1>
          <p>Configure a cadência e a biblioteca de mídias usadas nas mensagens automáticas.</p>
        </div>
      </header>
      <AiFollowUpSettingsPanel />
    </Shell>
  );
}
