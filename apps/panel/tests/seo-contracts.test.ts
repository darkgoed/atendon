import { describe, expect, it, vi } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { metadata as rootMetadata } from "@/app/layout";
import { metadata as loginMetadata } from "@/app/login/layout";

// next/font/google só existe sob o transform SWC do Next (build). Importar
// @/app/layout no Vitest puro quebra em "(0, Schibsted_Grotesk) is not a
// function" — o stub devolve o shape do loader (variable/className/style)
// sem rede nem fontes compiladas. Mock local: nenhum outro teste importa o
// layout raiz.
vi.mock("next/font/google", () => ({
  Schibsted_Grotesk: () => ({ variable: "--font-display-crm", className: "", style: {} })
}));

describe("crawler contracts", () => {
  it("keeps the private panel out of indexes by default", () => {
    expect(rootMetadata.robots).toMatchObject({ index: false, follow: false });
  });

  it("exposes only the canonical login page", () => {
    expect(loginMetadata.alternates).toEqual({ canonical: "/login" });
    expect(loginMetadata.robots).toMatchObject({ index: true, follow: true });
    expect(sitemap()).toEqual([{ url: "https://atendon.alpdash.com.br/login", changeFrequency: "monthly", priority: 0.5 }]);
  });

  it("allows login and disallows every other path", () => {
    expect(robots()).toEqual({
      rules: [{ userAgent: "*", allow: ["/login", "/llms.txt"], disallow: "/" }],
      sitemap: "https://atendon.alpdash.com.br/sitemap.xml"
    });
  });
});
