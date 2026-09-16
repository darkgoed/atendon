function normalizedUsername(value?: string | null): string | null {
  const username = value?.trim().replace(/^@+/u, "");
  return username || null;
}

export function instagramDisplayIdentity(
  username?: string | null,
  contactIdentifier?: string | null
): string {
  const normalized = normalizedUsername(username);
  if (normalized) return `@${normalized}`;

  const identifier = contactIdentifier?.trim();
  if (identifier?.startsWith("@")) {
    const identifierUsername = normalizedUsername(identifier);
    if (identifierUsername) return `@${identifierUsername}`;
  }
  return "Identidade do Instagram indisponível";
}

export function instagramDisplayName(
  contactName?: string | null,
  username?: string | null,
  contactIdentifier?: string | null,
  phone?: string | null
): string {
  const name = contactName?.trim();
  if (name) return name;
  const identity = instagramDisplayIdentity(username, contactIdentifier);
  if (identity !== "Identidade do Instagram indisponível") return identity;
  return phone?.trim() || "Contato do Instagram";
}
