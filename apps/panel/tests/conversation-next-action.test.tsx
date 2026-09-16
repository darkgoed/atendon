// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationNextAction } from "@/components/conversation-next-action";
import { ConversationPreBriefing } from "@/components/conversation-pre-briefing";

const onSaved = vi.fn();

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" }
  });
}

function renderAction(overrides: Partial<React.ComponentProps<typeof ConversationNextAction>> = {}) {
  return render(
    <ConversationNextAction
      leadId="lead-real"
      nextAction={null}
      nextActionAt={null}
      assignedUserEmail={null}
      timezone="America/Sao_Paulo"
      canManage
      onSaved={onSaved}
      {...overrides}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ConversationNextAction", () => {
  it("exige descrição e data no formulário real antes de enviar", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}));
    renderAction();
    await user.click(screen.getByRole("button", { name: "Editar próxima ação" }));

    const description = screen.getByRole("textbox", { name: /Descrição/ });
    const date = screen.getByLabelText(/Data e hora local/);
    expect(description).toBeRequired();
    expect(date).toBeRequired();

    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("envia a data digitada no fuso local, sem convertê-la para UTC", async () => {
    const user = userEvent.setup();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push({ url: String(input), init });
      return jsonResponse({});
    });
    renderAction();
    await user.click(screen.getByRole("button", { name: "Editar próxima ação" }));
    await user.type(screen.getByRole("textbox", { name: /Descrição/ }), "Ligar para confirmar o orçamento");
    fireEvent.change(screen.getByLabelText(/Data e hora local/), { target: { value: "2030-05-06T14:30" } });
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const followUp = requests.find(({ url }) => url.endsWith("/scheduling/leads/lead-real/follow-up"));
    expect(followUp?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(followUp?.init?.body))).toEqual({
      proxima_acao: "Ligar para confirmar o orçamento",
      proxima_acao_em_local: "2030-05-06T14:30"
    });
    expect(String(followUp?.init?.body)).not.toContain("Z");
  });

  it("marca vencimento com warn, atualiza o relógio e limpa o intervalo ao desmontar", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-05-06T14:29:59.000Z"));
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    const { unmount } = renderAction({
      nextAction: "Retomar contato",
      nextActionAt: "2030-05-06T14:30:00.000Z"
    });
    expect(screen.queryByText("Pendência")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1_000));
    // Intenção: ao vencer, o bloco inteiro assume o tratamento de AVISO.
    // Os nomes de token mudaram no refactor do design system: `--warn` era um
    // alias legado e a cor de status COMO TEXTO agora é `--warning-text` (a
    // variante corrigida para WCAG AA sobre todas as superfícies); `--warn-border`
    // virou `--warning-border`. O comportamento verificado é o mesmo.
    expect(screen.getByText("Pendência")).toHaveClass("text-[var(--warning-text)]");
    expect(screen.getByText("Retomar contato")).toHaveClass("text-[var(--warning-text)]");
    expect(screen.getByRole("region")).toHaveClass("border-[var(--warning-border)]");

    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it("mantém responsável fora do modal e não busca nem altera assignee", async () => {
    const user = userEvent.setup();
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push(`${String(input)} ${String(init?.body ?? "")}`);
      return jsonResponse({});
    });

    renderAction({ assignedUserEmail: "real@example.com" });
    await user.click(screen.getByRole("button", { name: "Editar próxima ação" }));
    expect(screen.queryByLabelText("Responsável")).not.toBeInTheDocument();
    expect(screen.getByText("Responsável: real@example.com")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: /Descrição/ }), "Confirmar dados");
    fireEvent.change(screen.getByLabelText(/Data e hora local/), { target: { value: "2030-05-06T14:30" } });
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(requests.some((request) => request.includes("/scheduling/leads/lead-real/follow-up"))).toBe(true));
    expect(requests.some((request) => request.includes("/conversations/assignees"))).toBe(false);
    expect(requests.some((request) => request.includes("/conversations/conversation-contract-7/assign"))).toBe(false);
  });
});

describe("ConversationPreBriefing", () => {
  it("omite campos ausentes, trata attribution como texto e não lança com tudo nulo", () => {
    const { rerender } = render(
      <ConversationPreBriefing
        source={null}
        campaign={null}
        interest={null}
        facebookAttribution={{ origem_facebook: " <img src=x onerror=alert(1)> " }}
      />
    );
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeVisible();
    expect(screen.queryByText("Ana Souza")).not.toBeInTheDocument();
    expect(screen.queryByText("Telefone")).not.toBeInTheDocument();
    expect(screen.queryByText("Campanha")).not.toBeInTheDocument();
    expect(screen.queryByText("Interesse")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();

    expect(() => rerender(
      <ConversationPreBriefing source={null} campaign={null} interest={null} facebookAttribution={null} />
    )).not.toThrow();
    expect(screen.getByText("Sem dados de briefing ainda")).toBeVisible();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("usa origem do Facebook quando source está vazio", () => {
    render(
      <ConversationPreBriefing
        source=""
        campaign={null}
        interest={null}
        facebookAttribution={{ origem_facebook: "facebook" }}
      />
    );

    expect(screen.getByText("facebook")).toBeVisible();
  });
});
