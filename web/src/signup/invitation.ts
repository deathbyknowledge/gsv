import type { OwnerWelcome } from "../app/services/session/ownerWelcome";

/** Keeps an invitation link's `invite` value through reloads; a link's own value replaces a stored one. */
export async function captureInvite(client: OwnerWelcome, linked: string | null): Promise<string | null> {
  const pending = linked ?? client.state.invite ?? null;
  if (pending !== (client.state.invite ?? null)) await client.save({ invite: pending });
  return pending;
}
