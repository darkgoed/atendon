import { describe, expect, it, vi } from "vitest";
import { MeetingConfirmationProcessor } from "../src/modules/scheduling/meeting-confirmation.js";

const claimed = {
  id: "o1",
  tenantId: "t1",
  appointmentId: "a1",
  conversationId: "c1",
  sessionId: "s1",
  destination: "5511999999999",
  messageText: "Ana, nossa conversa está marcada pra hoje às 16h Segue tudo certo pra você?",
  moment: "duas_horas_antes" as const,
  state: "solicitada" as const
};

function setup(flagEnabled = true) {
  const repository = {
    claim: vi.fn().mockResolvedValue(claimed),
    markAttemptStarted: vi.fn().mockResolvedValue(true),
    markSent: vi.fn().mockResolvedValue(undefined),
    markUncertain: vi.fn().mockResolvedValue(undefined),
    markSuppressed: vi.fn().mockResolvedValue(undefined)
  };
  const gateway = { sendText: vi.fn().mockResolvedValue({ externalId: "m1" }) };
  const isEnabled = vi.fn().mockResolvedValue(flagEnabled);
  const processor = new MeetingConfirmationProcessor(repository as never, gateway, isEnabled);
  return { repository, gateway, isEnabled, processor };
}

describe("disparo da confirmação de reunião", () => {
  it("envia e registra o envio no caminho feliz", async () => {
    const { processor, gateway, repository } = setup();
    expect(await processor.process("o1")).toBe("sent");
    expect(gateway.sendText).toHaveBeenCalledExactlyOnceWith("s1", "5511999999999", claimed.messageText);
    expect(repository.markSent).toHaveBeenCalledWith(claimed, "m1");
  });

  it("marca incerto sem reenviar quando o provider falha", async () => {
    // Uma falha de rede não prova que o WhatsApp recusou a mensagem;
    // duplicar mensagem para o lead é pior do que não enviar.
    const { processor, gateway, repository } = setup();
    gateway.sendText.mockRejectedValue(new Error("network"));
    expect(await processor.process("o1")).toBe("uncertain");
    expect(gateway.sendText).toHaveBeenCalledOnce();
    expect(repository.markUncertain).toHaveBeenCalledOnce();
    expect(repository.markSent).not.toHaveBeenCalled();
  });

  it("NÃO envia nada com a feature flag desligada", async () => {
    const { processor, gateway, repository } = setup(false);
    expect(await processor.process("o1")).toBe("suppressed");
    expect(gateway.sendText).not.toHaveBeenCalled();
    expect(repository.markAttemptStarted).not.toHaveBeenCalled();
    expect(repository.markSuppressed).toHaveBeenCalledOnce();
  });

  it("consulta a flag do tenant da própria entrega", async () => {
    const { processor, isEnabled } = setup();
    await processor.process("o1");
    expect(isEnabled).toHaveBeenCalledWith("t1");
  });

  it("não chama o gateway quando o claim não devolve nada", async () => {
    const { processor, gateway, repository } = setup();
    repository.claim.mockResolvedValue(null);
    expect(await processor.process("o1")).toBe("skipped");
    expect(gateway.sendText).not.toHaveBeenCalled();
  });

  it("não envia duas vezes quando outro worker já iniciou a tentativa", async () => {
    const { processor, gateway, repository } = setup();
    repository.markAttemptStarted.mockResolvedValue(false);
    expect(await processor.process("o1")).toBe("skipped");
    expect(gateway.sendText).not.toHaveBeenCalled();
  });
});
