import { describe, expect, it } from "vitest";
import { finalInvitationState, newPasswordsMatch } from "../app/invitations/[token]/invitation-state";

describe("invitation acceptance copy", () => {
  it("offers login only after an accepted invitation", () => {
    expect(finalInvitationState("accepted")).toMatchObject({
      title: "Convite já aceito",
      canLogin: true
    });
    expect(finalInvitationState("revoked")).toMatchObject({
      title: "Convite revogado",
      canLogin: false
    });
    expect(finalInvitationState("expired")).toMatchObject({
      title: "Convite expirado",
      canLogin: false
    });
  });

  it("requires an exact confirmation for a new password", () => {
    expect(newPasswordsMatch("new-password", "new-password")).toBe(true);
    expect(newPasswordsMatch("new-password", "different-password")).toBe(false);
  });
});
