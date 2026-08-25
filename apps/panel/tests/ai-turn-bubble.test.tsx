import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { describe, expect, it } from "vitest";
import { AiTurnBubble } from "../components/ai-turn-bubble";

describe("AI turn bubble", () => {
  it("renders an accessible unsent preview and truncation notice", () => {
    const html = renderToStaticMarkup(<AiTurnBubble progress={{
      type: "conversation.ai.progress",
      conversationId: "conversation-1",
      turnId: "turn-1",
      attempt: 1,
      revision: 3,
      phase: "preview",
      label: "Prévia · ainda não enviada",
      preview: "Primeira bolha\n\nSegunda bolha",
      previewTruncated: true,
      startedAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-10T10:00:01.000Z",
      expiresAt: "2026-08-10T10:30:01.000Z"
    }} />);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Prévia · ainda não enviada");
    expect(html).toContain("Primeira bolha\n\nSegunda bolha");
    expect(html).toContain("Prévia abreviada no painel");
  });
});
