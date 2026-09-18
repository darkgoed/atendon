// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlowConnect, type FlowConnectItem } from "@/components/flow-connect";

/* jsdom não mede layout (getBoundingClientRect = 0 e não há ResizeObserver):
   os testes asserem ESTRUTURA (papéis, contagens, atributos, forma do path —
   "L" reto vs "C" curvo), nunca pixels. */

const items: FlowConnectItem[] = [
  { key: "lead", label: "Lead capturado", description: "Formulário ou WhatsApp" },
  { key: "triagem", label: "Triagem da IA" },
  { key: "atendimento", label: "Atendimento humano" },
];

type RectSpec = { left: number; top: number; width: number; height: number };

function domRect({ left, top, width, height }: RectSpec): DOMRect {
  return {
    x: left,
    y: top,
    width,
    height,
    left,
    top,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function mockRects(specs: RectSpec[]) {
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute("data-direction")) return domRect({ left: 0, top: 0, width: 1000, height: 200 });
    if (this.hasAttribute("data-flow-card")) {
      const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-flow-card]"));
      const index = cards.indexOf(this);
      return domRect(specs[index] ?? { left: 0, top: 0, width: 0, height: 0 });
    }
    return domRect({ left: 0, top: 0, width: 0, height: 0 });
  });
}

function overlay() {
  const svg = document.querySelector('svg[aria-hidden="true"]');
  expect(svg).not.toBeNull();
  return Array.from(svg!.querySelectorAll("path")).map((path) => path.getAttribute("d") ?? "");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FlowConnect", () => {
  it("renderiza role=list com um listitem por item, sem numeração", () => {
    const { container } = render(<FlowConnect items={items} />);

    const list = screen.getByRole("list");
    expect(list).toHaveAttribute("data-direction", "auto");
    expect(container.querySelector("ol")).toBeNull();
    const listItems = screen.getAllByRole("listitem");
    expect(listItems).toHaveLength(items.length);
    expect(listItems[0]).toHaveTextContent("Lead capturado");
    expect(listItems[2]).toHaveTextContent("Atendimento humano");
    // pausa visual igual aos cards do sistema: reusa a primitive .card
    listItems.forEach((item) => expect(item.className).toContain("card"));
  });

  it("desenha conectores de fallback entre os cards (itens - 1), aria-hidden, sem overlay medido", () => {
    const { container } = render(<FlowConnect items={items} />);

    const connectors = container.querySelectorAll("[data-flow-connector]");
    expect(connectors).toHaveLength(items.length - 1);
    connectors.forEach((connector) => expect(connector).toHaveAttribute("aria-hidden", "true"));
    expect(container.querySelector('svg[aria-hidden="true"]')).toBeNull();
    expect(document.querySelector("[data-measured]")).toBeNull();
  });

  it("não renderiza nada sem itens", () => {
    const { container } = render(<FlowConnect items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("aceita direction explícito via data-direction", () => {
    render(
      <>
        <FlowConnect items={items} direction="horizontal" />
        <FlowConnect items={items} direction="vertical" />
      </>,
    );
    expect(screen.getAllByRole("list")[0]).toHaveAttribute("data-direction", "horizontal");
    expect(screen.getAllByRole("list")[1]).toHaveAttribute("data-direction", "vertical");
  });

  it("com medição real: overlay SVG com itens-1 conectores (linha + cabeça) e slots inline ocultos", async () => {
    mockRects([
      { left: 0, top: 0, width: 280, height: 80 },
      { left: 296, top: 0, width: 280, height: 80 },
      { left: 592, top: 0, width: 280, height: 80 },
    ]);
    render(<FlowConnect items={items} />);

    await waitFor(() => expect(document.querySelector("[data-measured]")).not.toBeNull());
    const paths = overlay();
    expect(paths).toHaveLength((items.length - 1) * 2);
    paths.forEach((d) => expect(d).not.toContain("C")); // mesma linha → setas retas
  });

  it("na quebra de linha o conector entre linhas vira curva (path cúbico)", async () => {
    mockRects([
      { left: 0, top: 0, width: 300, height: 80 }, // fim da linha 1
      { left: 316, top: 96, width: 300, height: 80 }, // início da linha 2 (wrap)
      { left: 632, top: 96, width: 300, height: 80 },
    ]);
    render(<FlowConnect items={items} direction="horizontal" />);

    await waitFor(() => expect(overlay()).toHaveLength(4));
    const [wrap] = overlay();
    expect(wrap).toContain("C"); // curva em S
  });

  it("em direction vertical os conectores apontam para baixo, retos, um por par", async () => {
    mockRects([
      { left: 0, top: 0, width: 400, height: 80 },
      { left: 0, top: 96, width: 400, height: 80 },
      { left: 0, top: 192, width: 400, height: 80 },
    ]);
    render(<FlowConnect items={items} direction="vertical" />);

    await waitFor(() => expect(overlay()).toHaveLength(4));
    overlay().forEach((d) => expect(d).not.toContain("C"));
  });

  it("observa o container com ResizeObserver quando disponível e desconecta ao desmontar", () => {
    const observed: Element[] = [];
    const disconnect = vi.fn();
    class FakeResizeObserver {
      observe: (element: Element) => void;
      unobserve: (element: Element) => void;
      disconnect: () => void;
      constructor() {
        this.observe = vi.fn((element: Element) => observed.push(element));
        this.unobserve = vi.fn();
        this.disconnect = disconnect;
      }
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { unmount } = render(<FlowConnect items={items} />);

    expect(observed).toHaveLength(1);
    expect(observed[0]).toHaveAttribute("data-direction", "auto");
    unmount();
    expect(disconnect).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("erro de medição cai no fallback (setas retas, sem overlay) sem quebrar", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => {
      throw new Error("medição indisponível");
    });
    const { container } = render(<FlowConnect items={items} />);

    expect(container.querySelectorAll("[data-flow-connector]")).toHaveLength(items.length - 1);
    expect(container.querySelector('svg[aria-hidden="true"]')).toBeNull();
  });
});
