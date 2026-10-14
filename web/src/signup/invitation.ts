import { parseCreationInvitation } from "@humansandmachines/gsv/protocol";
import type { OwnerWelcome } from "../app/services/session/ownerWelcome";

/** Persist before removing the bearer code, so a reload can resume signup. */
export async function captureCreationInvitation(client: OwnerWelcome, href: string, replace: (url: string) => void): Promise<void> {
  const url = new URL(href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (!fragment.has("invite")) return;
  const inviteCode = parseCreationInvitation(href);
  await client.save({ flow: "create", inviteCode, inviteId: null, handle: null });
  fragment.delete("invite");
  url.hash = fragment.toString();
  replace(url.href);
}
