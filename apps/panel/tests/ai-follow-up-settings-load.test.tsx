// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMock }));

import { AiFollowUpSettingsPanel } from "../components/ai-follow-up-settings-panel";

const SAVED = { enabled: true, delaysMinutes: [30, 600], delivery: [{ type: "text" }, { type: "sticker", assetId: "sticker-old" }] };
const STICKERS = { stickers: [{ id: "sticker-new", name: "Joinha", enabled: true }, { id: "sticker-old", name: "Aceno", enabled: false }] };

function renderPanel() {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <AiFollowUpSettingsPanel />
    </SWRConfig>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("follow-ups da IA: falha ao carregar (C7)", () => {
  it("não permite salvar os padrões quando a configuração falhou ao carregar, e recupera com Tentar novamente", async () => {
    const user = userEvent.setup();
    let settingsFails = true;
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/ai-follow-ups/settings" && !init?.method) {
        return settingsFails ? Promise.reject(new Error("Serviço indisponível")) : Promise.resolve({ settings: SAVED });
      }
      if (path === "/ai-follow-ups/media") return Promise.resolve({ media: [] });
      if (path === "/ai-stickers") return Promise.resolve(STICKERS);
      return Promise.resolve({ settings: SAVED });
    });
    renderPanel();
    expect(await screen.findByText("Serviço indisponível")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Salvar cadência/ })).toBeDisabled();

    settingsFails = false;
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Salvar cadência/ })).toBeEnabled());
    expect(screen.getByLabelText("Atraso cumulativo da tentativa 1, em minutos")).toHaveValue(30);
    expect(apiMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });
});

describe("follow-ups da IA: figurinha desativada (S7)", () => {
  it("mostra a figurinha salva como indisponível em vez de fingir que a primeira ativa está selecionada", async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/ai-follow-ups/settings" && init?.method === "PUT") return Promise.resolve({ settings: JSON.parse(String(init.body)) });
      if (path === "/ai-follow-ups/settings") return Promise.resolve({ settings: SAVED });
      if (path === "/ai-follow-ups/media") return Promise.resolve({ media: [] });
      if (path === "/ai-stickers") return Promise.resolve(STICKERS);
      return Promise.resolve({});
    });
    renderPanel();
    const select = await screen.findByLabelText("Figurinha para descontrair");
    await waitFor(() => expect(select).toHaveDisplayValue("Figurinha indisponível — escolha outra"));

    await user.selectOptions(select, "sticker-new");
    await user.click(screen.getByRole("button", { name: /Salvar cadência/ }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/ai-follow-ups/settings", expect.objectContaining({ method: "PUT" })));
    const put = apiMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(String(put[1].body)).delivery[1]).toEqual({ type: "sticker", assetId: "sticker-new" });
  });
});
