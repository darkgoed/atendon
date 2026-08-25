export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

type FinalInvitationState = {
  title: string;
  description: string;
  canLogin: boolean;
};

const FINAL_INVITATION_STATES: Record<Exclude<InvitationStatus, "pending">, FinalInvitationState> = {
  accepted: {
    title: "Convite já aceito",
    description: "Sua conta já tem acesso a este workspace.",
    canLogin: true
  },
  revoked: {
    title: "Convite revogado",
    description: "Este convite foi cancelado pelo administrador e não pode mais ser utilizado.",
    canLogin: false
  },
  expired: {
    title: "Convite expirado",
    description: "O prazo deste convite terminou. Peça ao administrador um novo convite.",
    canLogin: false
  }
};

export function finalInvitationState(status: Exclude<InvitationStatus, "pending">) {
  return FINAL_INVITATION_STATES[status];
}

export function newPasswordsMatch(password: string, confirmation: string) {
  return password === confirmation;
}
