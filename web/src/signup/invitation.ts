import type { OwnerWelcome } from "../app/services/session/ownerWelcome";

export async function captureContactInvitation(client: OwnerWelcome, contactInvite: string | null): Promise<string | null> {
  const pending = contactInvite ?? client.state.contactInvite ?? null;
  if (pending !== client.state.contactInvite) await client.save({ contactInvite: pending });
  return pending;
}
