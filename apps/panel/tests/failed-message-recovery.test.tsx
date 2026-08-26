import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FailedMessageRecovery } from "../components/failed-message-recovery";

describe("FailedMessageRecovery", () => {
  it("renders the recovery control and explains the delivery scope", () => {
    vi.stubGlobal("React", React);
    const html = renderToStaticMarkup(
      <FailedMessageRecovery
        recovery={{ available: 3, ambiguous: 1, has_connected_session: true, legacy_unrecoverable: 8, oldest_at: "2026-08-26T11:57:37.027Z" }}
        canManage
        recovering={false}
        confirming={false}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        onRecover={() => undefined}
      />
    );

    expect(html).toContain("Mensagens não entregues");
    expect(html).toContain("3 mensagens de texto");
    expect(html).toContain("Reenviar mensagens");
    expect(html).toContain("8 falhas antigas");
    expect(html).toContain("1 envio foi aceito");
  });

  it("disables recovery when no stored message can be resent", () => {
    vi.stubGlobal("React", React);
    const html = renderToStaticMarkup(
      <FailedMessageRecovery
        recovery={{ available: 0, ambiguous: 0, has_connected_session: true, legacy_unrecoverable: 8, oldest_at: null }}
        canManage
        recovering={false}
        confirming={false}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        onRecover={() => undefined}
      />
    );

    expect(html).toContain("Nenhuma mensagem recuperável");
    expect(html).toContain("disabled");
  });
});
