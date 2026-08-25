import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTripzIdempotencyKey,
  createTripzConversation,
  deleteTripzConversation,
  generateTripzPdf,
  generateTripzPreview,
  getTripzConversation,
  normalizeTripzDocument,
  normalizeTripzProposal,
  renameTripzConversation,
  retryTripzMessage,
  selectLatestTripzProposal,
  sendTripzMessage,
  shouldSubmitTripzComposer,
  uploadTripzAttachment,
  validateTripzFiles
} from "../lib/tripz-ai";

afterEach(() => vi.unstubAllGlobals());

describe("Tripz AI panel contract", () => {
  it("prefers the freshest proposal revision across detail and proposal polling", () => {
    const stale = normalizeTripzProposal({ revision: 3, state: { status: "collecting" } });
    const fresh = normalizeTripzProposal({ revision: 4, state: { status: "ready_for_review" } });
    expect(selectLatestTripzProposal(stale, fresh)).toBe(fresh);
    expect(selectLatestTripzProposal(fresh, stale)).toBe(fresh);
  });

  it("normalizes the backend proposal state without losing review issues", () => {
    const proposal = normalizeTripzProposal({
      proposal: {
        id: "proposal-1",
        revision: 7,
        state: {
          schemaVersion: 1,
          title: "Lua de mel em Aruba",
          client: { name: "Marina e Caio" },
          destination: "Aruba",
          status: "ready_for_review",
          missingInformation: [{ code: "HOTEL_MEAL", path: "hotel.mealPlan", label: "Regime de alimentação", required: true }],
          inconsistencies: [{ code: "PRICE_CONFLICT", message: "Confirme o valor total", severity: "warning", requiresConfirmation: true }]
        }
      }
    });

    expect(proposal).toMatchObject({
      id: "proposal-1",
      revision: 7,
      title: "Lua de mel em Aruba",
      clientName: "Marina e Caio",
      destination: "Aruba",
      status: "ready_for_review",
      missingInformation: ["Regime de alimentação"],
      inconsistencies: ["Confirme o valor total"]
    });
  });

  it("joins detail attachments to their persisted messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      conversation: {
        id: "conversation-1",
        title: "Aruba",
        status: "collecting",
        processingStatus: "idle",
        createdAt: "2026-08-14T10:00:00.000Z",
        updatedAt: "2026-08-14T10:00:00.000Z"
      },
      proposal: { id: "proposal-1", revision: 0, state: { schemaVersion: 1, status: "collecting" } },
      messages: [{ id: "message-1", role: "user", content: "Seguem os voos", createdAt: "2026-08-14T10:01:00.000Z" }],
      attachments: [{
        id: "attachment-1",
        messageId: "message-1",
        fileName: "voos.png",
        mimeType: "image/png",
        sizeBytes: 4300,
        processingStatus: "processed"
      }],
      documents: []
    })));

    const detail = await getTripzConversation("conversation-1");
    expect(detail.messages?.[0]?.attachments).toEqual([expect.objectContaining({
      id: "attachment-1",
      filename: "voos.png",
      processingStatus: "processed"
    })]);
  });

  it("uploads every attachment as its own binary request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      attachment: {
        id: "attachment-2",
        fileName: "hotel.webp",
        mimeType: "image/webp",
        sizeBytes: 4,
        processingStatus: "pending"
      },
      reused: false
    }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File([new Uint8Array([82, 73, 70, 70])], "hotel.webp", { type: "image/webp" });

    await expect(uploadTripzAttachment("conversation-2", file)).resolves.toMatchObject({
      id: "attachment-2",
      filename: "hotel.webp"
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/tripz-ai\/conversations\/conversation-2\/attachments$/);
    expect(init.body).toBe(file);
    expect(new Headers(init.headers).get("Content-Type")).toBe("image/webp");
    expect(new Headers(init.headers).get("X-File-Name")).toBe("hotel.webp");
  });

  it("uses an idempotency key and attachment ids for message creation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      message: { id: "message-2", role: "user", content: "Hotel confirmado", createdAt: "2026-08-14T10:02:00.000Z" },
      reused: false
    }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendTripzMessage("conversation-2", {
      content: "Hotel confirmado",
      attachmentIds: ["attachment-2"],
      idempotencyKey: "message:test-123"
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("message:test-123");
    expect(JSON.parse(String(init.body))).toEqual({ content: "Hotel confirmado", attachmentIds: ["attachment-2"] });
  });

  it("retries the same persisted failed message without re-uploading attachments", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      message: {
        id: "message-failed",
        role: "user",
        content: "Seguem os anexos",
        processingStatus: "queued",
        createdAt: "2026-08-14T10:02:00.000Z"
      },
      reused: false
    }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(retryTripzMessage("conversation-2", "message-failed"))
      .resolves.toMatchObject({ message: { id: "message-failed", processingStatus: "queued" } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/messages\/message-failed\/retry$/);
    expect(init.method).toBe("POST");
  });

  it("keeps preview HTML from the response envelope and identifies ready documents", () => {
    expect(normalizeTripzDocument({
      document: { id: "document-1", kind: "preview", mimeType: "text/html" },
      html: "<!doctype html><title>Tripz</title>"
    }, "preview")).toMatchObject({
      id: "document-1",
      kind: "preview",
      status: "ready",
      html: "<!doctype html><title>Tripz</title>"
    });
  });

  it("renames a conversation through the isolated conversation endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      conversation: {
        id: "conversation-rename",
        title: "Lua de mel em Aruba",
        status: "collecting",
        processingStatus: "idle",
        createdAt: "2026-08-14T10:00:00.000Z",
        updatedAt: "2026-08-14T10:05:00.000Z"
      }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(renameTripzConversation("conversation-rename", "Lua de mel em Aruba"))
      .resolves.toMatchObject({ id: "conversation-rename", title: "Lua de mel em Aruba" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/tripz-ai\/conversations\/conversation-rename$/);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ title: "Lua de mel em Aruba" });
  });

  it("covers the create, preview, PDF and delete API flow under the isolated namespace", async () => {
    const conversation = {
      id: "conversation-3",
      title: "Patagônia",
      status: "ready_for_pdf",
      processingStatus: "idle",
      createdAt: "2026-08-14T10:00:00.000Z",
      updatedAt: "2026-08-14T10:03:00.000Z"
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ conversation, proposal: { revision: 3 } }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({
        document: { id: "preview-3", kind: "preview", mimeType: "text/html" },
        html: "<!doctype html><h1>Patagônia</h1>"
      }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({
        document: { id: "pdf-3", kind: "pdf", mimeType: "application/pdf" },
        downloadUrl: "/tripz-ai/conversations/conversation-3/documents/pdf-3/content"
      }, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createTripzConversation()).resolves.toMatchObject({ id: "conversation-3", title: "Patagônia" });
    await expect(generateTripzPreview("conversation-3", 3)).resolves.toMatchObject({ id: "preview-3", html: expect.stringContaining("Patagônia") });
    await expect(generateTripzPdf("conversation-3", 3)).resolves.toMatchObject({ id: "pdf-3", kind: "pdf", status: "ready" });
    await expect(deleteTripzConversation("conversation-3")).resolves.toBeUndefined();

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringMatching(/\/tripz-ai\/conversations$/),
      expect.stringMatching(/\/tripz-ai\/conversations\/conversation-3\/preview$/),
      expect.stringMatching(/\/tripz-ai\/conversations\/conversation-3\/pdf$/),
      expect.stringMatching(/\/tripz-ai\/conversations\/conversation-3$/)
    ]);
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({ expectedRevision: 3 });
    expect(JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body))).toEqual({ expectedRevision: 3 });
  });
});

describe("Tripz composer guards", () => {
  it("accepts supported images and PDFs while enforcing per-type limits", () => {
    const image = new File([new Uint8Array(1024)], "hotel.png", { type: "image/png" });
    const pdf = new File([new Uint8Array(1024)], "roteiro.pdf", { type: "application/pdf" });
    const html = new File(["<html>"], "dados.html", { type: "text/html" });
    const result = validateTripzFiles([image, pdf, html]);
    expect(result.accepted).toEqual([image, pdf]);
    expect(result.rejected).toEqual([{ file: html, reason: "Formato não aceito. Use JPEG, PNG, WebP ou PDF." }]);
  });

  it("rejects a valid individual file when the composer batch would exceed 40 MB", () => {
    const image = new File(["x"], "hotel.png", { type: "image/png" });
    Object.defineProperty(image, "size", { value: 10 * 1024 * 1024 });
    const result = validateTripzFiles([image], 10, 35 * 1024 * 1024);
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reason).toContain("limite total de 40 MB");
  });

  it("sends with Enter but preserves Shift+Enter and input composition", () => {
    expect(shouldSubmitTripzComposer({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
    expect(shouldSubmitTripzComposer({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false);
    expect(shouldSubmitTripzComposer({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
  });

  it("creates printable idempotency keys accepted by the backend contract", () => {
    const key = createTripzIdempotencyKey("message");
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(200);
    expect(key).toMatch(/^[\x21-\x7E]+$/);
  });
});
