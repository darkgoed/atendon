import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api";
import { confirmedFailedSend, definitiveProviderRejection } from "../lib/conversation-send";

describe("conversation send recovery", () => {
  it("starts a fresh user-requested attempt after the backend confirms the previous failure", () => {
    expect(confirmedFailedSend(new ApiError("fallback", 409, {
      error: "Envio anterior falhou: Evolution API recusou a operação (HTTP 400)"
    }))).toBe(true);
    expect(confirmedFailedSend(new ApiError("Envio ainda está em andamento", 409))).toBe(false);
  });

  it("releases the key immediately only for definitive Evolution rejections", () => {
    expect(definitiveProviderRejection(new ApiError(
      "Evolution API recusou a operação (HTTP 400): Bad Request",
      502
    ))).toBe(true);
    expect(definitiveProviderRejection(new ApiError(
      "Evolution API recusou a operação (HTTP 500): Internal Server Error",
      502
    ))).toBe(false);
    expect(definitiveProviderRejection(new Error("Falha de rede"))).toBe(false);
  });
});
