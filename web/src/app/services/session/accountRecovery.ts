import type { GSVClient } from "@humansandmachines/gsv/client";
import { createPairingSecret } from "@humansandmachines/gsv/protocol";
import { z } from "zod";

export type AccountRecoveryAttempt = { id: string; secret: string; proof: string };
const RECOVERY_STORAGE = "gsv.ui.account-recovery.v1";
const INVITATION_STORAGE = "gsv.ui.human-invitation.v1";
const attemptSchema = z.strictObject({ id: z.uuid(), secret: z.string().min(32).max(256), proof: z.string().min(32).max(256) });

/** Persist the receiver's proof before a redeem request; a lost reply never permits a second receiver. */
export function readAccountRecoveryAttempt(): AccountRecoveryAttempt | null {
  return readCredentialClaim(RECOVERY_STORAGE);
}

export function readHumanInvitationAttempt(): AccountRecoveryAttempt | null {
  return readCredentialClaim(INVITATION_STORAGE);
}

function readCredentialClaim(storageKey: string): AccountRecoveryAttempt | null {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const id = fragment.get("id");
  const secret = fragment.get("secret");
  const saved = window.sessionStorage.getItem(storageKey);
  let existing: AccountRecoveryAttempt | null = null;
  if (saved) {
    try {
      existing = attemptSchema.parse(JSON.parse(saved));
    } catch {}
  }
  if (!id || !secret) return existing;
  if (!/^[a-f0-9-]{36}$/.test(id) || secret.length < 32 || secret.length > 256) return null;
  const attempt = existing?.id === id && existing.secret === secret ? existing : { id, secret, proof: createPairingSecret() };
  window.sessionStorage.setItem(storageKey, JSON.stringify(attempt));
  window.history.replaceState(window.history.state, "", window.location.pathname);
  return attempt;
}

export async function redeemAccountRecovery(client: Pick<GSVClient, "requestOnce">, url: string, attempt: AccountRecoveryAttempt, password: string): Promise<void> {
  await client.requestOnce(url, "account.recovery.redeem", { ...attempt, password });
  window.sessionStorage.removeItem(RECOVERY_STORAGE);
}

export async function redeemHumanInvitation(client: Pick<GSVClient, "requestOnce">, url: string, attempt: AccountRecoveryAttempt, password: string): Promise<{ uid: number; username: string }> {
  const result = await client.requestOnce(url, "account.invite.redeem", { ...attempt, password });
  window.sessionStorage.removeItem(INVITATION_STORAGE);
  return result;
}
