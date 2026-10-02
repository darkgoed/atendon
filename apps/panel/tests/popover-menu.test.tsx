// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PopoverMenu } from "@/components/popover-menu";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("PopoverMenu — ajuda compacta no botão real", () => {
  it.each([
    ["Transferir", "Transferir"],
    ["Mais ações da conversa", "Mais ações"],
  ])("mantém %s e mostra %s no hover", async (ariaLabel, title) => {
    const user = userEvent.setup();
    const { container } = render(<PopoverMenu ariaLabel={ariaLabel} title={title} icon={<svg aria-hidden="true" />}>
      {() => <div>Menu aberto</div>}
    </PopoverMenu>);
    const button = screen.getByRole("button", { name: ariaLabel });
    expect(button.parentElement).toBe(container);
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(button.querySelector("button")).toBeNull();
    expect(button).not.toHaveAttribute("title");
    expect(button).toHaveAccessibleDescription(title);
    await user.hover(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(title);
    expect(document.querySelector(".tooltip--compact")).not.toBeNull();
    expect(screen.queryByText("Menu aberto")).toBeNull();
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Menu aberto").parentElement?.parentElement).toBe(document.body);
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Menu aberto")).toBeNull();
  });

  it("usa ariaLabel no foco quando title não existe e não abre o menu", async () => {
    const user = userEvent.setup();
    render(<PopoverMenu ariaLabel="Transferir">{() => <div>Menu aberto</div>}</PopoverMenu>);
    await user.tab();
    const button = screen.getByRole("button", { name: "Transferir" });
    expect(button).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Transferir");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Menu aberto")).toBeNull();
    await user.keyboard("{Enter}");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Menu aberto")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Menu aberto")).toBeNull();
  });

  it("preserva o nome do label quando só title fornece ajuda", async () => {
    render(<PopoverMenu label="Opções" title="Mais ações">{() => null}</PopoverMenu>);
    const button = screen.getByRole("button", { name: "Opções" });
    fireEvent.focus(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Mais ações");
    expect(button).not.toHaveAttribute("title");
  });

  it("sem title nem ariaLabel mantém botão sem tooltip", async () => {
    const user = userEvent.setup();
    const { container } = render(<PopoverMenu label="Opções">{() => <div>Menu aberto</div>}</PopoverMenu>);
    const button = screen.getByRole("button", { name: "Opções" });
    expect(container.children).toHaveLength(1);
    expect(button).not.toHaveAttribute("aria-describedby");
    await user.hover(button);
    fireEvent.focus(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.click(button);
    expect(screen.getByText("Menu aberto")).toBeInTheDocument();
  });

  it.each(["start", "end"] as const)("mantém ref, posição %s e fechamento do portal", async (align) => {
    const user = userEvent.setup();
    render(<PopoverMenu ariaLabel="Mais ações" align={align} panelClassName="test-menu">
      {(close) => <button onClick={close}>Concluir</button>}
    </PopoverMenu>);
    const button = screen.getByRole("button", { name: "Mais ações" });
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({ top: 20, bottom: 50, left: 30, right: 90, width: 60, height: 30, x: 30, y: 20, toJSON: () => ({}) });
    const originalBox = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("test-menu")
        ? { top: 56, bottom: 156, left: 8, right: 208, width: 200, height: 100, x: 8, y: 56, toJSON: () => ({}) }
        : originalBox.call(this);
    });
    await user.click(button);
    const panel = screen.getByRole("button", { name: "Concluir" }).parentElement!;
    expect(panel.parentElement).toBe(document.body);
    expect(panel.style.position).toBe("fixed");
    expect(panel.style.top).toBe("56px");
    expect(align === "start" ? panel.style.left : panel.style.right).toBe(align === "start" ? "30px" : `${Math.max(8, window.innerWidth - 90)}px`);
    await user.click(screen.getByRole("button", { name: "Concluir" }));
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.click(button);
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(button).toHaveAttribute("aria-expanded", "false"));
  });

  it("toque abre o menu sem exigir tooltip em viewport móvel", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(360);
    render(<PopoverMenu ariaLabel="Transferir" title="Transferir">{() => <div>Menu aberto</div>}</PopoverMenu>);
    const button = screen.getByRole("button", { name: "Transferir" });
    fireEvent.pointerDown(button, { pointerType: "touch" });
    fireEvent.pointerUp(button, { pointerType: "touch" });
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Menu aberto")).toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Menu aberto")).toBeNull();
  });
});
