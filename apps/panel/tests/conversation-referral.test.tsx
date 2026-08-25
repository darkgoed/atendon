import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConversationReferral } from "../components/conversation-referral";

describe("ConversationReferral", () => {
  it("renders useful Meta campaign metadata in the conversation", () => {
    const markup = renderToStaticMarkup(<ConversationReferral attribution={{
      provider: "meta",
      channel: "instagram",
      source_app: "instagram",
      source_type: "ad",
      source_id: "120249583544180078",
      source_url: "https://www.instagram.com/p/DbL6cGNA9hx/",
      headline: "Financiamento para sua loja",
      body: "Mais opções de pagamento para seus clientes.",
      prefilled_fields: { "Nicho da empresa": "Scooters" }
    }} />);

    expect(markup).toContain("Anúncio do Instagram");
    expect(markup).toContain("Financiamento para sua loja");
    expect(markup).toContain("120249583544180078");
    expect(markup).toContain("Nicho da empresa");
    expect(markup).toContain("Scooters");
    expect(markup).toContain("https://www.instagram.com/p/DbL6cGNA9hx/");
  });

  it("does not render an empty or unsafe attribution", () => {
    expect(renderToStaticMarkup(<ConversationReferral attribution={{}} />)).toBe("");
    const markup = renderToStaticMarkup(<ConversationReferral attribution={{
      source_type: "ad",
      source_url: "javascript:alert(1)",
      headline: "Campanha segura"
    }} />);
    expect(markup).toContain("Campanha segura");
    expect(markup).not.toContain("javascript:");
  });
});
