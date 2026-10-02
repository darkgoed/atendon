// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PipelineOrigin } from "@/components/pipeline-origin";

afterEach(cleanup);

describe("ícones de origem e campanha do pipeline", () => {
  it.each([
    ["WhatsApp", "whatsapp"], ["instagram", "instagram"], ["facebook_ads", "facebook"],
    ["Google Ads", "google"], ["Indicação", "unknown"], ["instagrammer", "unknown"]
  ])("identifica %s sem inventar canal", (origem, expected) => {
    render(<PipelineOrigin lead={{ origem }} />);
    const icon = screen.getByRole("img", { name: `Origem: ${origem}` });
    expect(icon).toHaveAttribute("data-platform", expected);
    expect(icon).toHaveAttribute("title", `Origem: ${origem}`);
    expect(icon.querySelector("svg")).toBeTruthy();
  });

  it("não confunde a campanha Instagram com a origem WhatsApp", () => {
    render(<PipelineOrigin lead={{ origem: "WhatsApp", campanha: "Instagram verão" }} />);
    expect(screen.getByRole("img", { name: "Origem: WhatsApp" })).toHaveAttribute("data-platform", "whatsapp");
    expect(screen.getByRole("img", { name: "Campanha: Instagram verão" })).toHaveAttribute("data-platform", "instagram");
    expect(document.querySelector(".pipeline-card__origin")).toHaveAttribute("title", "WhatsApp · Instagram verão");
  });

  it.each([
    ["https://www.instagram.com/p/123", "instagram"],
    ["https://m.facebook.com/123", "facebook"],
    ["https://instagram.com.evil.example/123", "unknown"],
    ["https://example.com/?utm_source=instagram", "unknown"],
    ["não é URL", "unknown"]
  ])("usa o hostname real da atribuição %s", (source_url, expected) => {
    render(<PipelineOrigin lead={{ campanha: "Anúncio de verão", origem_facebook: { source_url, source_type: "ad" } }} />);
    expect(screen.getByRole("img", { name: "Campanha: Anúncio de verão" })).toHaveAttribute("data-platform", expected);
  });

  it("metadata genérica ad não prova Facebook; headline fornece o texto sem trocar o canal", () => {
    render(<PipelineOrigin lead={{ origem_facebook: { headline: "Oferta", source_type: "ad" } }} />);
    expect(screen.getByRole("img", { name: "Campanha: Oferta" })).toHaveAttribute("data-platform", "unknown");
  });

  it("não renderiza ícones sem dados", () => {
    render(<PipelineOrigin lead={{}} />);
    expect(screen.queryByRole("img")).toBeNull();
  });
});
