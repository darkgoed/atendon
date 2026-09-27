import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ITALIA_SPEC, PORTO_SPEC, placeholderAssets } from "../src/fixtures/references.js";
import { buildProposalPages, PROPOSAL_RENDERER_VERSION, formatShortDate } from "../src/pages.js";
import { ProposalDocument } from "../src/document.js";
import { renderProposalHtml } from "../src/render.js";
import { TRIPZ_PROPOSAL_BRAND } from "../src/brand.js";
import type { ProposalSpec } from "../src/spec.js";

const italiaIds = (spec: ProposalSpec) => buildProposalPages(spec).map((page) => page.id);

describe("buildProposalPages — ITALIA_SPEC", () => {
  it("deriva 10 páginas na ordem editorial", () => {
    expect(italiaIds(ITALIA_SPEC)).toEqual([
      "cover",
      "concept",
      "overview",
      "destination:roma",
      "destination:sorrento",
      "destination:maiori",
      "destination:napoles",
      "services",
      "flights",
      "closing"
    ]);
  });

  it("kinds correspondem aos ids", () => {
    const pages = buildProposalPages(ITALIA_SPEC);
    expect(pages.map((page) => page.kind)).toEqual([
      "cover", "concept", "overview", "destination", "destination", "destination", "destination",
      "services", "flights", "closing"
    ]);
  });

  it("resolve fotos por role+targetId e dias por destinationId", () => {
    const pages = buildProposalPages(ITALIA_SPEC);
    const roma = pages.find((page) => page.id === "destination:roma");
    if (!roma || roma.kind !== "destination") throw new Error("destination:roma ausente");
    expect(roma.data.photo?.mediaId).toBe("media-roma");
    expect(roma.data.timeline?.rows.length).toBeGreaterThan(0);
    expect(roma.data.timeline?.rows[0]?.dateLabel).toBe("19 MAI");
    expect(roma.data.hotel?.name).toBe("Kent Hotel Roma");
    expect(formatShortDate("2026-05-20")).toBe("20 MAI");
  });

  it("fechamento carrega investimento formatado pt-BR", () => {
    const pages = buildProposalPages(ITALIA_SPEC);
    const closing = pages.find((page) => page.id === "closing");
    if (!closing || closing.kind !== "closing") throw new Error("closing ausente");
    expect(closing.data.investment?.value.replace(/\u00a0/g, " ")).toBe("R$ 36.243,34");
    expect(closing.data.steps).toHaveLength(3);
  });
});

describe("buildProposalPages — PORTO_SPEC", () => {
  it("deriva 7 páginas sem hardcode", () => {
    expect(italiaIds(PORTO_SPEC)).toEqual([
      "cover",
      "concept",
      "destination:porto",
      "hotel:hf-fenix",
      "services",
      "flights",
      "closing"
    ]);
  });

  it("hotel dedicado tem galeria com 2+ fotos", () => {
    const pages = buildProposalPages(PORTO_SPEC);
    const hotel = pages.find((page) => page.id === "hotel:hf-fenix");
    if (!hotel || hotel.kind !== "hotel") throw new Error("hotel:hf-fenix ausente");
    expect(hotel.data.gallery.length).toBeGreaterThanOrEqual(2);
    expect(hotel.data.roomCard?.title).toBe("Quarto Comfort");
    expect(hotel.data.cancellationCard?.text).toContain("16 de fevereiro de 2027");
  });

  it("experiências com destinationId não geram página dedicada", () => {
    expect(PORTO_SPEC.experiences.every((exp) => exp.destinationId === "porto")).toBe(true);
    expect(italiaIds(PORTO_SPEC)).not.toContain("experiences");
  });
});

describe("pageOverrides", () => {
  it("esconde página opcional e nunca cover/closing", () => {
    const spec: ProposalSpec = {
      ...PORTO_SPEC,
      pageOverrides: [
        { page: "concept", hidden: true },
        { page: "cover", hidden: true },
        { page: "closing", hidden: true }
      ]
    };
    const pages = buildProposalPages(spec);
    const byId = new Map(pages.map((page) => [page.id, page]));
    expect(byId.get("concept")?.hidden).toBe(true);
    expect(byId.get("cover")?.hidden).toBe(false);
    expect(byId.get("closing")?.hidden).toBe(false);
  });

  it("order desloca a sequência de forma estável", () => {
    const spec: ProposalSpec = {
      ...PORTO_SPEC,
      pageOverrides: [{ page: "flights", order: -50 }]
    };
    const ids = buildProposalPages(spec).map((page) => page.id);
    expect(ids.indexOf("flights")).toBeLessThan(ids.indexOf("destination:porto"));
  });
});

describe("ProposalDocument", () => {
  it("resolve src das fotos e não quebra com assets vazio", () => {
    const markup = renderToStaticSafe(ITALIA_SPEC, {});
    expect(markup).toContain("tp-doc");
    expect(markup).not.toContain('src="data:image');
    const markupWithAssets = renderToStaticSafe(ITALIA_SPEC, placeholderAssets(
      ITALIA_SPEC.imageAssignments.map((assignment) => assignment.mediaId)
    ));
    expect(markupWithAssets).toContain(ITALIA_SPEC.imageAssignments[0].mediaId === undefined ? "" : 'src="data:image/png');
  });

  it("aplica brand tokens como CSS vars", () => {
    const markup = renderToStaticSafe(ITALIA_SPEC, {});
    expect(markup).toContain("--tp-primary:#123047");
  });
});

function renderToStaticSafe(spec: ProposalSpec, assets: Record<string, { kind: "data" | "url"; src: string }>): string {
  return renderToStaticMarkup(
    ProposalDocument({ spec, brand: TRIPZ_PROPOSAL_BRAND, context: { brand: TRIPZ_PROPOSAL_BRAND, assets } })
  );
}

describe("renderProposalHtml", () => {
  const assets = placeholderAssets([
    ...ITALIA_SPEC.imageAssignments.map((assignment) => assignment.mediaId),
    ...PORTO_SPEC.imageAssignments.map((assignment) => assignment.mediaId)
  ]);

  it("inline: font-face base64 + css embutido + páginas A4 + imgs data URI", () => {
    const html = renderProposalHtml({ spec: ITALIA_SPEC, brand: TRIPZ_PROPOSAL_BRAND, assets });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("@font-face");
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).toContain("@page { size: A4; margin: 0; }");
    const plain = html.replace(/\u00a0/g, " ");
    expect(plain).toContain("PROPOSTA DE VIAGEM");
    expect(plain).toContain("Itália Autêntica");
    expect(plain).toContain("R$ 36.243,34");
    expect(html).toContain(".tp-page");
    const pageCount = (html.match(/class="tp-page tp-/g) ?? []).length;
    expect(pageCount).toBe(10);
    expect(html).toContain('src="data:image/png');
  });

  it("external: font-face aponta para /proposal-fonts", () => {
    const html = renderProposalHtml({
      spec: ITALIA_SPEC,
      brand: TRIPZ_PROPOSAL_BRAND,
      assets,
      fontMode: "external",
      fontBaseUrl: "/proposal-fonts"
    });
    expect(html).toContain("url('/proposal-fonts/noto-serif-display-var-latin.woff2')");
    expect(html).not.toContain("data:font/woff2;base64,");
  });

  it("determinístico: mesma entrada → mesmo HTML", () => {
    const a = renderProposalHtml({ spec: PORTO_SPEC, brand: TRIPZ_PROPOSAL_BRAND, assets });
    const b = renderProposalHtml({ spec: PORTO_SPEC, brand: TRIPZ_PROPOSAL_BRAND, assets });
    expect(a).toBe(b);
    expect((a.match(/class="tp-page tp-/g) ?? []).length).toBe(7);
  });
});

describe("contrato", () => {
  it("versão fixada", () => {
    expect(PROPOSAL_RENDERER_VERSION).toBe("tripz-editorial-v2");
  });

  it("PageData snapshot (JSON) da derivação Porto", () => {
    const snapshot = buildProposalPages(PORTO_SPEC).map((page) => ({
      id: page.id,
      kind: page.kind,
      hidden: page.hidden,
      mediaIds: JSON.stringify(page.data).match(/media-[a-z0-9-]+/g) ?? []
    }));
    expect(snapshot).toMatchInlineSnapshot(`
      [
        {
          "hidden": false,
          "id": "cover",
          "kind": "cover",
          "mediaIds": [
            "media-porto-douro",
          ],
        },
        {
          "hidden": false,
          "id": "concept",
          "kind": "concept",
          "mediaIds": [
            "media-porto-ribeira",
          ],
        },
        {
          "hidden": false,
          "id": "destination:porto",
          "kind": "destination",
          "mediaIds": [
            "media-porto-roteiro",
          ],
        },
        {
          "hidden": false,
          "id": "hotel:hf-fenix",
          "kind": "hotel",
          "mediaIds": [
            "media-fenix-lobby",
            "media-fenix-fachada",
            "media-fenix-terrace",
          ],
        },
        {
          "hidden": false,
          "id": "services",
          "kind": "services",
          "mediaIds": [],
        },
        {
          "hidden": false,
          "id": "flights",
          "kind": "flights",
          "mediaIds": [
            "media-flights-capture-porto",
          ],
        },
        {
          "hidden": false,
          "id": "closing",
          "kind": "closing",
          "mediaIds": [
            "media-porto-closing",
          ],
        },
      ]
    `);
  });
});
