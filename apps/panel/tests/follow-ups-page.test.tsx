// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("@phosphor-icons/react", () => ({
  Clock: () => null, ChatCircleDots: () => null, ClockCountdown: () => null, FloppyDisk: () => null,
  ImageSquare: () => null, Plus: () => null, Prohibit: () => null, Sticker: () => null,
  Trash: () => null, UploadSimple: () => null
}));

import FollowUpsPage from "../app/follow-ups/page";

describe("rota de follow-ups", () => {
  beforeEach(() => {
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/ai-follow-ups/settings" && init?.method === "PUT") {
        return Promise.resolve({ settings: { enabled: true, delaysMinutes: [120, 1440, 4320], delivery: [{ type: "text" }, { type: "text" }, { type: "text" }] } });
      }
      if (path === "/ai-follow-ups/settings") return Promise.resolve({ settings: { enabled: false, delaysMinutes: [120, 1440, 4320], delivery: [{ type: "text" }, { type: "text" }, { type: "text" }] } });
      if (path === "/ai-follow-ups/media") return Promise.resolve({ media: [{ id: "image-1", name: "Case", description: "Desc", mime_type: "image/png", file_name: "case.png", size_bytes: 1 }] });
      if (path === "/ai-stickers") return Promise.resolve({ stickers: [{ id: "sticker-1", name: "Oi", enabled: true }] });
      return Promise.resolve({});
    });
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it("renderiza o toggle, tentativas e formatos disponíveis", async () => {
    render(<FollowUpsPage />);
    expect(await screen.findByText("Cadência automática")).toBeInTheDocument();
    expect(screen.getByText("Inativo")).toBeInTheDocument();
    expect(screen.getAllByText(/ª tentativa/)).toHaveLength(3);
    expect(screen.getAllByLabelText("Formato do envio")).toHaveLength(3);
    expect(screen.getAllByRole("option", { name: "Somente texto" })).toHaveLength(3);
    expect(screen.getAllByRole("option", { name: "Imagem + texto" })).toHaveLength(3);
    expect(screen.getAllByRole("option", { name: "Figurinha sem texto" })).toHaveLength(3);
  });

  it("salva a cadência usando PUT", async () => {
    const user = userEvent.setup();
    render(<FollowUpsPage />);
    await screen.findByText("Cadência automática");
    await user.click(screen.getByLabelText("Inativo"));
    await user.click(screen.getByRole("button", { name: "Salvar cadência" }));
    expect(apiMock).toHaveBeenCalledWith("/ai-follow-ups/settings", expect.objectContaining({ method: "PUT" }));
    expect(apiMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });
});
