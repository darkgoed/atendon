// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api }));
vi.mock("../components/page-state", () => ({
  Empty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));
vi.mock("swr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("swr")>();
  return { ...actual, default: actual.default };
});

import { SWRConfig } from "swr";
import { StorageMediaGallery, type StorageMediaItem } from "../components/storage-media-gallery";

function item(overrides: Partial<StorageMediaItem>): StorageMediaItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    type: "sticker",
    deletable: true,
    created_at: "2026-10-01T10:00:00Z",
    file_name: "sticker-1.webp",
    mime_type: "image/webp",
    size_bytes: 2048,
    ...overrides
  };
}

const PAGE = {
  items: [
    item({ id: "11111111-1111-4111-8111-111111111111", type: "sticker", file_name: "sticker-1.webp" }),
    item({ id: "22222222-2222-4222-8222-222222222222", type: "tripz", deletable: false, file_name: "proposta.pdf", mime_type: "application/pdf", size_bytes: 8192 })
  ],
  has_more: false,
  next_cursor: null
};

function setup(canManage = true, onChanged = vi.fn(), data: unknown = PAGE) {
  api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith("/organization/storage/media") && (init as RequestInit | undefined)?.method === "DELETE") {
      return { deleted: 1 };
    }
    if (path.startsWith("/organization/storage/media")) return data;
    return {};
  });
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <StorageMediaGallery canManage={canManage} onChanged={onChanged} />
    </SWRConfig>
  );
}

beforeEach(() => {
  cleanup();
  api.mockReset();
  vi.stubGlobal("confirm", vi.fn(() => true));
});

describe("galeria de mídia (B10)", () => {
  it("lista mídias com tipo, tamanho e marca não-removível para tripz", async () => {
    setup();
    expect(await screen.findByText("Figurinha da IA")).toBeInTheDocument();
    expect(screen.getByText("sticker-1.webp")).toBeInTheDocument();
    expect(screen.getByText("2,0 KB")).toBeInTheDocument();
    expect(screen.getByText("Documento IA")).toBeInTheDocument();
    expect(screen.getByText("não removível")).toBeInTheDocument();
    // Checkbox só para itens deletáveis com permissão.
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });

  it("exclui em lote apenas o que é deletável e recarrega", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    setup(true, onChanged);
    await user.click(await screen.findByRole("checkbox", { name: /Selecionar Figurinha da IA/ }));
    await user.click(screen.getByRole("button", { name: "Excluir 1 selecionada(s)" }));
    expect(vi.mocked(confirm)).toHaveBeenCalledTimes(1);
    const call = api.mock.calls.find(([path, init]) => path === "/organization/storage/media" && (init as RequestInit).method === "DELETE");
    expect(call).toBeTruthy();
    // tripz (não deletável) nunca entra no payload.
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
      items: [{ type: "sticker", id: "11111111-1111-4111-8111-111111111111" }]
    });
    expect(await screen.findByText("1 mídia(s) excluída(s).")).toBeInTheDocument();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("sem permissão não oferece seleção nem exclusão", async () => {
    setup(false);
    expect(await screen.findByText("Figurinha da IA")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Excluir/ })).toBeNull();
  });

  it("erro do DELETE aparece com a mensagem do backend", async () => {
    const user = userEvent.setup();
    api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/organization/storage/media") && (init as RequestInit | undefined)?.method === "DELETE") {
        return Promise.reject(new Error("Limite de 200 itens por exclusão"));
      }
      if (path.startsWith("/organization/storage/media")) return PAGE;
      return {};
    });
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <StorageMediaGallery canManage onChanged={() => undefined} />
      </SWRConfig>
    );
    await user.click(await screen.findByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Excluir 1 selecionada(s)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Limite de 200 itens por exclusão");
  });

  it("estado vazio quando não há mídias", async () => {
    setup(true, vi.fn(), { items: [], has_more: false, next_cursor: null });
    expect(await screen.findByText("Nenhuma mídia armazenada neste workspace.")).toBeInTheDocument();
  });
});
