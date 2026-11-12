import type { GSVClient } from "@humansandmachines/gsv/client";
import { createPairingSecret } from "@humansandmachines/gsv/protocol";
import { z } from "zod";

export type RecoveryAccount = "personal" | "administrator";
export type AccountRecoveryAttempt = { id: string; secret: string; proof: string; account?: RecoveryAccount };
const RECOVERY_STORAGE = "gsv.ui.account-recovery.v1";
const attemptSchema = z.strictObject({ id: z.uuid(), secret: z.string().min(32).max(256), proof: z.string().min(32).max(256), account: z.enum(["personal", "administrator"]).optional() });
const optionsSchema = z.object({ emailUrl: z.url({ protocol: /^https?$/ }).optional() });
const personalUnavailableSchema = z.object({ details: z.object({ recovery: z.literal("personal-unavailable") }) });

/** Persist the receiver's proof before a redeem request; a lost reply never permits a second receiver. */
export function readAccountRecoveryAttempt(): AccountRecoveryAttempt | null {
  return readCredentialClaim(RECOVERY_STORAGE);
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

/** The account choice is saved with the proof: a retry after a lost reply must repeat the same request. */
export async function redeemAccountRecovery(client: Pick<GSVClient, "requestOnce">, url: string, attempt: AccountRecoveryAttempt, password: string, account: RecoveryAccount): Promise<void> {
  const { id, secret, proof } = attempt;
  window.sessionStorage.setItem(RECOVERY_STORAGE, JSON.stringify({ id, secret, proof, account }));
  await client.requestOnce(url, "account.recovery.redeem", { id, secret, proof, password, account });
  window.sessionStorage.removeItem(RECOVERY_STORAGE);
}

export function isPersonalAccountUnavailable(error: Error): boolean {
  return personalUnavailableSchema.safeParse(error).success;
}

/** Where this Ship's owner email recovery starts, if it has one. A failed read offers the alternatives instead. */
export async function readRecoveryOptions(client: Pick<GSVClient, "requestOnce">, url: string): Promise<{ emailUrl?: string }> {
  try {
    const options = optionsSchema.safeParse(await client.requestOnce(url, "account.recovery.options", {}));
    return options.success ? options.data : {};
  } catch {
    return {};
  }
}
