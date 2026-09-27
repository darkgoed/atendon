// @vitest-environment jsdom
/**
 * Editor de proposta (Wave D): thumbnails derivadas do preview, edição do
 * resumo via PATCH, bloqueio de finalize com issues críticas e troca de foto
 * atualizando o assignment.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import { TripzProposalEditor } from "../components/tripz-ai/proposal-editor";
import type { TripzProposal } from "@/lib/tripz-ai";

const conversationId = "11111111-1111-1111-1111-111111111111";

vi.mock("@/lib/tripz-ai", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tripz-ai")>("@/lib/tripz-ai");
  return {
    ...actual,
    generateTripzPreview: vi.fn(async () => ({
      id: "doc-1",
      kind: "preview",
      status: "ready",
      proposalRevision: 3,
      html: `<!doctype html><html><body>
        <section class="tp-page tp-cover" data-page-id="cover"><h1 class="tp-cover__title">Porto</h1></section>
        <section class="tp-page tp-concept" data-page-id="concept">Conceito</section>
        <section class="tp-page tp-closing" data-page-id="closing">Fechamento</section>
      </body></html>`
    })),
    generateTripzPdf: vi.fn(),
    listTripzProposalVersions: vi.fn(async () => []),
    validateTripzProposalState: vi.fn(async () => ({
      missingInformation: [],
      issues: [{ code: "INVESTMENT_CONFLICT", message: "O investimento informado diverge do pricing.", severity: "critical", requiresConfirmation: true }],
      canFinalize: false
    })),
    patchTripzProposal: vi.fn(async (_conversationId: string, _revision: number, patch: Record<string, unknown>) => {
      return { ...baseProposal(), revision: 4, state: { ...baseProposal().state, ...(patch as object) } };
    }),
    finalizeTripzProposal: vi.fn(async () => ({ version: { id: "v1", versionNumber: 1, documentRevision: 3, createdAt: new Date().toISOString() } })),
    revertTripzProposalVersion: vi.fn(),
    sendTripzMessage: vi.fn(),
    tripzMediaFromUrl: vi.fn(),
    uploadTripzAttachment: vi.fn()
  };
});

function baseProposal(): TripzProposal {
  return {
    id: "prop-1",
    revision: 3,
    status: "ready_for_pdf",
    title: "Proposta O Porto",
    clientName: "Jhonny e Shayene",
    destination: "Porto, Portugal",
    startDate: "2026-05-20",
    endDate: "2026-05-24",
    state: {
      schemaVersion: 2,
      title: "Proposta O Porto",
      client: { name: "Jhonny e Shayene" },
      destination: "Porto, Portugal",
      startDate: "2026-05-20",
      endDate: "2026-05-24",
      passengers: { adults: 2 },
      flights: [],
      media: [],
      includedItems: [],
      itinerary: [],
      notes: [],
      generationRequirements: [],
      issueAcknowledgements: [],
      missingInformation: [],
      inconsistencies: [],
      status: "ready_for_pdf",
      editorial: {
        imageAssignments: [{ mediaId: "media-1", role: "cover", targetId: "cover" }]
      }
    },
    missingInformation: [],
    inconsistencies: [],
    updatedAt: new Date().toISOString()
  };
}

describe("TripzProposalEditor", () => {
  beforeEach(() => {
    vi.mocked(generateTripzPreview)
  });

  afterEach(cleanup);

  it("mostra a contagem de páginas derivada do preview", async () => {
    const proposal = baseProposal();
    render(<TripzProposalEditor conversationId={conversationId} proposal={proposal} onClose={() => undefined} onProposalChange={() => undefined} />);
    await waitFor(() => expect(screen.getByText("Páginas (3)")).toBeTruthy());
    expect(screen.getByText("Capa")).toBeTruthy();
    expect(screen.getByText("Fechamento")).toBeTruthy();
  });

  it("lista a foto do assignment e permite salvar novo mediaId via PATCH", async () => {
    const proposal = baseProposal();
    const { container } = render(<TripzProposalEditor conversationId={conversationId} proposal={proposal} onClose={() => undefined} onProposalChange={() => undefined} />);
    await waitFor(() => expect(screen.getByText("Fotos (1)")).toBeTruthy());
    const input = container.querySelector('input[value="media-1"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.blur(input, { target: { value: "media-2" } });
    await waitFor(() => expect(patchTripzProposal).toHaveBeenCalled());
    const patchCall = vi.mocked(patchTripzProposal).mock.calls.at(-1);
    expect(patchCall?.[2]).toMatchObject({ editorial: { imageAssignments: [{ mediaId: "media-2", role: "cover" }] } });
  });

  it("bloqueia Finalizar quando a validação tem issue crítica", async () => {
    const proposal = baseProposal();
    render(<TripzProposalEditor conversationId={conversationId} proposal={proposal} onClose={() => undefined} onProposalChange={() => undefined} />);
    await waitFor(() => expect(screen.getByText("O investimento informado diverge do pricing.")).toBeTruthy());
    const finalize = screen.getByRole("button", { name: "Finalizar proposta" }) as HTMLButtonElement;
    expect(finalize.disabled).toBe(true);
  });
});

import { generateTripzPreview, patchTripzProposal } from "@/lib/tripz-ai";
