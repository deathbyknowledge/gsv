export function discordId(value: string): string {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) throw new Error("Discord identity is invalid");
  return value;
}

export function discordAccount(applicationId: string, guildId?: string): string {
  return `application:${discordId(applicationId)}${guildId ? `:guild:${discordId(guildId)}` : ""}`;
}

export type DiscordAccountScope = { guildId?: string };

export function parseDiscordAccount(accountId: string, applicationId: string): DiscordAccountScope {
  if (accountId === discordAccount(applicationId)) return {};
  const prefix = `${discordAccount(applicationId)}:guild:`;
  if (!accountId.startsWith(prefix)) throw new Error("Discord application identity mismatch");
  return { guildId: discordId(accountId.slice(prefix.length)) };
}

export function discordActor(userId: string): string { return `discord:user:${discordId(userId)}`; }
export function discordUser(actorId: string): string {
  if (!actorId.startsWith("discord:user:")) throw new Error("Discord actor is invalid");
  return discordId(actorId.slice("discord:user:".length));
}
export function discordPeerName(accountId: string, actorId: string): string {
  return `peer:${accountId}:user:${discordUser(actorId)}`;
}
export function discordPairingCode(code: string): string {
  const normalized = code.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!/^[A-HJ-NP-Z2-9]{12}$/.test(normalized)) throw new Error("Pairing code is invalid");
  return normalized;
}
export function newDiscordPairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => alphabet[byte % alphabet.length]).join("");
}
