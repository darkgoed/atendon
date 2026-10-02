import { describe, expect, it, vi } from "vitest";
import { createEmptyTripzProposalState, type TripzAccessScope, type TripzProposalState } from "../src/modules/tripz-ai/domain.js";
import { attachWebImages, findPlacePhotos, wantsWebImages, type FetchLike } from "../src/modules/tripz-ai/media/web-images.js";
import { stateToSpec } from "../src/modules/tripz-ai/document/editorial.js";

const scope: TripzAccessScope = { tenantId: "tenant-1", userId: "user-1", canManage: false };
const CONVERSATION = "00000000-0000-4000-8000-000000000001";

function page(index: number, title: string, overrides: Record<string, unknown> = {}) {
  const file = title.replace(/ /g, "_");
  return {
    index,
    title: `File:${title}`,
    imageinfo: [{
      mime: "image/jpeg",
      width: 4000,
      height: 2500,
      thumburl: `https://upload.wikimedia.org/thumb/${file}`,
      descriptionurl: `https://commons.wikimedia.org/wiki/File:${file}`,
      extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" }, Artist: { value: "<a href=\"x\">Fulano</a>" } },
      ...overrides
    }]
  };
}

function fakeFetch(pages: unknown[]): FetchLike & ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    if (url.startsWith("https://pt.wikipedia.org/")) {
      const title = new URL(url).searchParams.get("titles") ?? "";
      const english = title.startsWith("Nova York") ? "New York City" : title;
      return new Response(JSON.stringify({ query: { pages: { 1: { langlinks: [{ "*": english }] } } } }));
    }
    if (url.startsWith("https://commons.wikimedia.org/")) {
      return new Response(JSON.stringify({ query: { pages: Object.fromEntries(pages.map((item, index) => [String(index), item])) } }));
    }
    if (url.startsWith("https://upload.wikimedia.org/")) {
      return new Response(Buffer.from(`jpeg:${url}`), { headers: { "content-type": "image/jpeg" } });
    }
    throw new Error(`unexpected ${url}`);
  }) as never;
}

describe("fotos da internet (Wikimedia Commons)", () => {
  it("detecta o pedido do agente e ignora negação", () => {
    expect(wantsWebImages("por favor, pegue imagens da internet e coloque no nosso pdf")).toBe(true);
    expect(wantsWebImages("Busque fotos no Google")).toBe(true);
    expect(wantsWebImages("não use fotos da internet")).toBe(false);
    expect(wantsWebImages("essa é a foto do hotel")).toBe(false);
  });

  it("filtra mapa, retrato, licença fechada, host estranho e título sem o lugar", async () => {
    const fetchImpl = fakeFetch([
      page(1, "Map of New York"),
      page(2, "New York portrait", { width: 2000, height: 3000 }),
      page(3, "New York skyline closed", { extmetadata: { LicenseShortName: { value: "All rights reserved" } } }),
      page(4, "New York evil host", { thumburl: "https://evil.example/x.jpg" }),
      page(5, "Statue of Liberty Paris"),
      page(7, "Grand Hotel New York lobby"),
      page(6, "Manhattan skyline from New York harbor")
    ]);
    const photos = await findPlacePhotos(fetchImpl, "Nova York, EUA", 3);
    expect(photos.map((photo) => photo.title)).toEqual(["Manhattan skyline from New York harbor"]);
    expect(photos[0].credit).toBe("Fulano / Wikimedia Commons, CC BY-SA 4.0");
  });

  it("nome de lugar ambíguo: descarta outro lugar com o mesmo começo", async () => {
    const fetchImpl = fakeFetch([page(1, "Porto Moniz Madeira view"), page(2, "Porto Alegre at night"), page(3, "Night cityscape of Porto, Portugal"), page(4, "Porto Cityscape river")]);
    const photos = await findPlacePhotos(fetchImpl, "Porto", 3);
    expect(photos.map((photo) => photo.title)).toEqual(["Night cityscape of Porto, Portugal", "Porto Cityscape river"]);
  });

  it("preenche capa, destino e fechamento vazios com créditos, sem tocar foto do agente", async () => {
    const fetchImpl = fakeFetch([page(1, "New York skyline one"), page(2, "New York skyline two"), page(3, "New York skyline three")]);
    let next = 0;
    const store = {
      createAttachment: vi.fn(async () => ({ attachment: { id: `00000000-0000-4000-8000-0000000001${String(next++).padStart(2, "0")}` } }))
    };
    const proposal: TripzProposalState = { ...createEmptyTripzProposalState(), destination: "Nova York, EUA" };
    const result = await attachWebImages({ scope, conversationId: CONVERSATION, proposal, store, fetchImpl });
    expect(result.added.map((item) => item.slot)).toEqual(["capa", "Nova York, EUA", "fechamento"]);
    expect(result.message).toContain("Wikimedia Commons");
    expect(new Set(result.proposal.media.map((media) => media.attachmentId)).size).toBe(3);
    const spec = stateToSpec(result.proposal, { tenantId: scope.tenantId });
    expect(spec.issues).toEqual([]);
    expect(spec.spec!.imageAssignments.map((assignment) => assignment.role)).toEqual(["cover", "destination", "closing"]);
    expect(spec.spec!.imageAssignments[0].source?.license).toBe("CC BY-SA 4.0");
    expect(spec.spec!.sources).toHaveLength(3);

    // Segunda chamada: tudo preenchido → não busca de novo nem troca nada.
    const again = await attachWebImages({ scope, conversationId: CONVERSATION, proposal: result.proposal, store, fetchImpl });
    expect(again.added).toEqual([]);
    expect(again.proposal).toBe(result.proposal);
  });

  it("sem destino pede o destino; sem resultado orienta enviar as fotos", async () => {
    const store = { createAttachment: vi.fn() };
    const empty = await attachWebImages({ scope, conversationId: CONVERSATION, proposal: createEmptyTripzProposalState(), store, fetchImpl: fakeFetch([]) });
    expect(empty.message).toContain("destino");
    const none = await attachWebImages({
      scope, conversationId: CONVERSATION,
      proposal: { ...createEmptyTripzProposalState(), destination: "Nova York" },
      store, fetchImpl: fakeFetch([])
    });
    expect(none.added).toEqual([]);
    expect(none.message).toContain("Envie as fotos");
    expect(store.createAttachment).not.toHaveBeenCalled();
  });
});
