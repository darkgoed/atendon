// @vitest-environment jsdom

// Testes de UI da logo do tenant (SPEC specs/active/logo-tenant-sidebar.md, R4/R5).
// Arquivo .ts (nome exigido pela SPEC), então as árvores usam React.createElement
// em vez de JSX.
//
// Mocks usados:
// - Canvas: o jsdom não implementa getContext("2d") nem toDataURL; espiamos os
//   dois protótipos e devolvemos um contexto stub + um data URL PNG fixo. O
//   padrão é livre (instrução da tarefa): cobrimos o fluxo do componente, não a
//   compressão real do canvas.
// - FileReader: o jsdom não decodifica Blobs em data URLs de forma confiável;
//   trocamos por um stub que resolve com o mesmo data URL fixo.
// - api: mockado no nível de "@/lib/api", roteando por path/método, para
//   assertar PATCH/DELETE de /workspaces/current/logo e a revalidação de /me.

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import ConfigPage from "@/app/configuracoes/page";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { WorkspaceLogoSection } from "@/components/workspace-logo";
import type { PanelSession } from "@/lib/session";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: mocks.api }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children?: import("react").ReactNode }) => createElement("div", null, children) }));
vi.mock("@/lib/capabilities", () => ({ useCapabilities: () => ({ isEnabled: () => false }) }));
vi.mock("@/components/web-push-settings", () => ({ WebPushSettings: () => null }));
vi.mock("@/components/conversation-queue-manager", () => ({ ConversationQueueManager: () => null }));
const permissionState = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/use-permission", () => ({ usePermission: () => permissionState.value }));

const FAKE_LOGO = "data:image/png;base64,iVBORw0KGgo=";

function sessionFixture(logo: string | null): PanelSession {
  const workspace = { id: "w-1", name: "Acme", slug: "acme", status: "active", role: "OWNER", logo_data: logo };
  return {
    user: { id: "u-1", email: "owner@example.com", isRoot: false, name: "Owner" },
    activeWorkspace: workspace,
    workspaces: [workspace],
    permissions: ["workspace.update"],
    actorScope: "workspace"
  };
}

const timezoneResponse = {
  workspace: { id: "w-1", name: "Acme", timezone: "America/Sao_Paulo", business_hours_start: "08:00:00", business_hours_end: "18:00:00" }
};

function renderPage() {
  return render(
    createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, createElement(ConfigPage))
  );
}

function stubBrowserMedia() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: ""
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(FAKE_LOGO);
  // O jsdom não carrega imagens: fazemos o Image fake disparar onload assim
  // que src é atribuído, com dimensões que exercitam a escala (512 → 256).
  vi.stubGlobal("Image", class {
    width = 512;
    height = 512;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  });
  class FakeFileReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL() {
      this.result = FAKE_LOGO;
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("FileReader", FakeFileReader);
}

describe("workspace switcher logo (R5)", () => {
  afterEach(cleanup);

  it("renders the logo image in the trigger and options when logo_data exists", async () => {
    const user = userEvent.setup();
    const workspaces = [
      { id: "w-1", name: "Acme", slug: "acme", status: "active", role: "OWNER", logo_data: FAKE_LOGO },
      { id: "w-2", name: "Beta", slug: "beta", status: "active", role: "MEMBER", logo_data: null }
    ];
    render(
      createElement(WorkspaceSwitcher, { workspaces, activeWorkspaceId: "w-1", onChange: () => {} })
    );
    const trigger = screen.getByRole("button", { name: /Acme/ });
    expect(trigger.querySelector("img.workspace-switcher__avatar-logo")).toHaveAttribute("src", FAKE_LOGO);
    await user.click(trigger);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0].querySelector("img")).toHaveAttribute("src", FAKE_LOGO);
    expect(options[1].querySelector("img")).toBeNull();
    expect(options[1].querySelector(".workspace-switcher__avatar")?.textContent).toBe("B");
  });

  it("falls back to the initial avatar when no logo_data is present", () => {
    const workspaces = [{ id: "w-1", name: "Acme", slug: "acme", status: "active", role: "OWNER" }];
    const { container } = render(
      createElement(WorkspaceSwitcher, { workspaces, activeWorkspaceId: "w-1", onChange: () => {} })
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".workspace-switcher__avatar")?.textContent).toBe("A");
  });
});

// A aba "workspace" só aparece depois que /me carrega (useEffect troca
// resource); esperar o painel de fuso horário garante que o input consultado
// não seja substituído por um re-render no meio da interação.
async function renderPageAndSettle() {
  renderPage();
  await screen.findByText("Fuso horário");
  return screen.findByLabelText("Escolher imagem da logo");
}

describe("workspace logo settings (R4)", () => {
  let meCalls: number;
  let storedLogo: string | null;

  beforeEach(() => {
    permissionState.value = true;
    meCalls = 0;
    storedLogo = null;
    mocks.api.mockReset();
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (path === "/me") {
        meCalls += 1;
        return sessionFixture(storedLogo);
      }
      if (path === "/workspaces/current/timezone") return timezoneResponse;
      if (path === "/workspaces/current/logo" && method === "PATCH") {
        storedLogo = JSON.parse(String(init?.body)).logo_data as string;
        return { workspace: { id: "w-1", name: "Acme", logo_data: storedLogo } };
      }
      if (path === "/workspaces/current/logo" && method === "DELETE") {
        storedLogo = null;
        return { workspace: { id: "w-1", name: "Acme", logo_data: null } };
      }
      throw new Error(`URL inesperada: ${path} ${method}`);
    });
    stubBrowserMedia();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the upload input on the Geral tab with workspace.update and no logo", async () => {
    renderPage();
    const input = await screen.findByLabelText("Escolher imagem da logo");
    expect(input).toBeInTheDocument();
    expect(input.getAttribute("accept")).toBe("image/png,image/jpeg,image/webp");
  });

  it("uploads, saves via PATCH with the resized data URL and revalidates /me", async () => {
    const user = userEvent.setup();
    const input = await renderPageAndSettle();
    const file = new File(["logo"], "logo.png", { type: "image/png" });
    await user.upload(input, file);
    const preview = await screen.findByAltText("Prévia da nova logo");
    expect(preview).toHaveAttribute("src", FAKE_LOGO);

    const meCallsBeforeSave = meCalls;
    await user.click(screen.getByRole("button", { name: "Salvar logo" }));
    await screen.findByText("Logo salva.");
    const patchCall = mocks.api.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
    expect(patchCall?.[0]).toBe("/workspaces/current/logo");
    expect(JSON.parse(String((patchCall?.[1] as RequestInit).body))).toEqual({ logo_data: FAKE_LOGO });
    await waitFor(() => expect(meCalls).toBeGreaterThan(meCallsBeforeSave));
  });

  it("removes the logo via DELETE and revalidates /me", async () => {
    const user = userEvent.setup();
    storedLogo = FAKE_LOGO;
    renderPage();
    await screen.findByAltText("Logo atual");
    const meCallsBeforeRemove = meCalls;
    await user.click(screen.getByRole("button", { name: "Remover logo" }));
    await screen.findByText("Logo removida.");
    const deleteCall = mocks.api.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "DELETE");
    expect(deleteCall?.[0]).toBe("/workspaces/current/logo");
    await waitFor(() => expect(meCalls).toBeGreaterThan(meCallsBeforeRemove));
  });

  it("renders read-only mode without workspace.update", async () => {
    // Cache SWR fresco por render: o cache global sujo de testes anteriores
    // (dedupingInterval 10s no componente) esconderia a refetch.
    const renderSection = () =>
      render(
        createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, createElement(WorkspaceLogoSection, { canManage: false }))
      );

    storedLogo = FAKE_LOGO;
    renderSection();
    expect(await screen.findByAltText("Logo atual")).toHaveAttribute("src", FAKE_LOGO);
    expect(screen.queryByLabelText("Escolher imagem da logo")).toBeNull();
    expect(screen.queryByRole("button", { name: "Salvar logo" })).toBeNull();

    cleanup();
    storedLogo = null;
    renderSection();
    expect(await screen.findByText("Nenhuma logo definida.")).toBeInTheDocument();
  });

  it("rejects non-image and oversized files before touching the canvas", async () => {
    // user-event filtra os arquivos pelo atributo accept (então um PDF nunca
    // dispararia change); para exercitar a rejeição, setamos files e disparamos
    // change diretamente, como o navegador faria.
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    const input = (await renderPageAndSettle()) as HTMLInputElement;
    const uploadRaw = (file: File) => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      fireEvent.change(input);
    };

    uploadRaw(new File(["x"], "doc.pdf", { type: "application/pdf" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Selecione um arquivo de imagem (PNG, JPEG ou WEBP).");

    const oversized = new File(["x".repeat(6)], "big.png", { type: "image/png" });
    Object.defineProperty(oversized, "size", { value: 6 * 1024 * 1024 });
    uploadRaw(oversized);
    expect(await screen.findByRole("alert")).toHaveTextContent("A imagem deve ter no máximo 5MB.");
    expect(getContext).not.toHaveBeenCalled();
  });
});
