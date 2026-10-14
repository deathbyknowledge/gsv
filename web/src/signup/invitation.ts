import { parseCreationInvitation, parseContactInvitation } from "@humansandmachines/gsv/protocol";
import type { OwnerWelcome } from "../app/services/session/ownerWelcome";

/** Persist before removing the bearer code, so a reload can resume signup. */
export async function captureCreationInvitation(client: OwnerWelcome, href: string, replace: (url: string) => void, contactInvite?: string | null): Promise<string | null> {
  const url = new URL(href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (!fragment.has("invite")) return contactInvite ?? client.state.contactInvite ?? null;
  const inviteCode = parseCreationInvitation(href);
  if (contactInvite && inviteCode !== `invite_${parseContactInvitation(contactInvite).invitation.token}`) throw new Error("Invitation links do not match");
  await client.save({ flow: "create", inviteCode, inviteId: null, handle: null, contactInvite: contactInvite ?? null });
  fragment.delete("invite");
  url.hash = fragment.toString();
  replace(url.href);
  return contactInvite ?? null;
}
