import type { GSVClient } from "@humansandmachines/gsv/client";
import { createPairingSecret } from "@humansandmachines/gsv/protocol";
import { z } from "zod";

const storageKey = "gsv.ui.owner-link.v1";
const retryLifetimeMs = 10 * 60 * 1000;
const attemptSchema = z.strictObject({
  id: z.uuid(),
  secret: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().finite().nonnegative(),
});

type OwnerLinkClient = { account: { owner: Pick<GSVClient["account"]["owner"], "link"> } };

export async function startOwnerLink(client: OwnerLinkClient): Promise<string> {
  const now = Date.now();
  const saved = window.sessionStorage.getItem(storageKey);
  let attempt: z.infer<typeof attemptSchema> | null = null;
  if (saved) {
    try { attempt = attemptSchema.parse(JSON.parse(saved)); } catch {}
  }
  // This browser retry window starts before dispatch; server expiry remains authoritative.
  if (!attempt || attempt.createdAt > now || now - attempt.createdAt >= retryLifetimeMs) {
    attempt = { id: crypto.randomUUID(), secret: createPairingSecret(), createdAt: now };
  }
  window.sessionStorage.setItem(storageKey, JSON.stringify(attempt));
  const result = await client.account.owner.link({ id: attempt.id, secret: attempt.secret });
  window.sessionStorage.removeItem(storageKey);
  return result.url;
}
