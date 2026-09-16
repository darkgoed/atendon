// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageActionsMenu } from "@/components/message-actions-menu";
import { instagramDisplayIdentity, instagramDisplayName } from "@/lib/channel-identity";

afterEach(() => cleanup());

describe("Instagram identity", () => {
  it("normalizes a username without duplicating @", () => {
    expect(instagramDisplayIdentity("@atendon", null)).toBe("@atendon");
    expect(instagramDisplayIdentity("@@atendon", null)).toBe("@atendon");
    expect(instagramDisplayName(null, "@atendon", "17841400000000000", null)).toBe("@atendon");
  });

  it("never presents an opaque Instagram id as an @ handle", () => {
    expect(instagramDisplayIdentity(null, "17841400000000000")).toBe("Identidade do Instagram indisponível");
    expect(instagramDisplayIdentity(null, "ig:17841400000000000")).toBe("Identidade do Instagram indisponível");
    expect(instagramDisplayName(null, null, "17841400000000000", null)).toBe("Contato do Instagram");
  });
});

describe("Instagram message actions", () => {
  it("keeps reply/copy but hides unsupported reaction/edit/delete interactions", async () => {
    const onReply = vi.fn();
    const onCopy = vi.fn();
    render(
      <MessageActionsMenu
        isOwn
        align="end"
        allowAdvanced={false}
        onReply={onReply}
        onCopy={onCopy}
        onReact={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Ações da mensagem" }));
    expect(screen.getByRole("button", { name: "Responder" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Copiar" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Reagir com/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Editar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Apagar/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Responder" }));
    expect(onReply).toHaveBeenCalledTimes(1);
  });
});
