import type { GSVClient } from "@humansandmachines/gsv/client";
import { createPairingSecret } from "@humansandmachines/gsv/protocol";
import { z } from "zod";

const pendingKey = "gsv.ui.issued-human-invitation.v1";
const pendingSchema = z.strictObject({ id: z.uuid(), username: z.string(), secret: z.string().regex(/^[a-f0-9]{64}$/) });

/** Remember mint authorization before sending so a dropped reply can recover the same invitation. */
export async function createHumanInvitation(client: { account: { invite: Pick<GSVClient["account"]["invite"], "create"> } }, username: string): Promise<string> {
  let saved: z.output<typeof pendingSchema> | null = null;
  try { saved = pendingSchema.parse(JSON.parse(window.sessionStorage.getItem(pendingKey) ?? "null")); } catch {}
  const attempt = saved?.username === username ? saved : { id: crypto.randomUUID(), username, secret: createPairingSecret() };
  window.sessionStorage.setItem(pendingKey, JSON.stringify(attempt));
  const invitation = await client.account.invite.create(attempt);
  if (invitation.status !== "pending") {
    window.sessionStorage.removeItem(pendingKey);
    throw new Error("This invitation has ended. Create another invitation to continue.");
  }
  const url = new URL("/join", window.location.origin);
  url.hash = new URLSearchParams({ id: attempt.id, secret: attempt.secret }).toString();
  return url.href;
}
