import type { GSVClient } from "@humansandmachines/gsv/client";
import { createPairingSecret } from "@humansandmachines/gsv/protocol";
import { z } from "zod";

const storageKey = "gsv.ui.member-recovery.v1";
const attemptSchema = z.strictObject({ id: z.uuid(), username: z.string(), proof: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.number() });
export type MemberRecoveryAttempt = z.infer<typeof attemptSchema>;

export function readMemberRecoveryAttempt(): MemberRecoveryAttempt | null {
  const saved = window.sessionStorage.getItem(storageKey);
  if (!saved) return null;
  try { return attemptSchema.parse(JSON.parse(saved)); } catch { return null; }
}

/** Save browser ownership before sending anything; a lost response retains the same recipient. */
export function createMemberRecoveryAttempt(username: string): MemberRecoveryAttempt {
  const normalized = username.trim().toLowerCase();
  const existing = readMemberRecoveryAttempt();
  if (existing?.username === normalized && existing.createdAt > Date.now() - 60_000) return existing;
  const attempt = { id: crypto.randomUUID(), username: normalized, proof: createPairingSecret(), createdAt: Date.now() };
  window.sessionStorage.setItem(storageKey, JSON.stringify(attempt));
  return attempt;
}

export async function startMemberRecovery(client: Pick<GSVClient, "requestOnce">, url: string, attempt: MemberRecoveryAttempt): Promise<void> {
  await client.requestOnce(url, "account.recovery.code.start", { id: attempt.id, username: attempt.username, proof: attempt.proof });
}

export async function redeemMemberRecovery(client: Pick<GSVClient, "requestOnce">, url: string, attempt: MemberRecoveryAttempt, code: string, password: string): Promise<string> {
  const result = await client.requestOnce(url, "account.recovery.code.redeem", { id: attempt.id, proof: attempt.proof, code: code.trim(), password });
  window.sessionStorage.removeItem(storageKey);
  return result.username;
}
