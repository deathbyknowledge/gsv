import type { GSVClient } from "@humansandmachines/gsv/client";
import { readSettingsPolicy } from "../../features/instrument/settings/settingsModel";

/** The account's approval override; blank means the inherited policy. */
export function accountApprovalKey(uid: number): string {
  return `users/${uid}/ai/tools/approval`;
}

/** The configuration a draft was composed against: its raw value when the draft was built. */
export type ApprovalPolicySource = { key: string; value: string };

/** Replace the account policy only if it still reads as the draft's base; blank returns to inheritance.
 *  When the draft was composed from an inherited source, that source must be unchanged too, so a
 *  newer installation policy is never rewritten into an override built on the old one. */
export async function saveAccountApprovalPolicy(
  client: Pick<GSVClient, "sys">, uid: number, previous: string, value: string, inherited?: ApprovalPolicySource,
): Promise<void> {
  if (value && !readSettingsPolicy(value)) throw new Error("The replacement policy is not valid. Review its rules before saving.");
  const key = accountApprovalKey(uid);
  const current = await client.sys.config.get({ key });
  if ((current.entries.find((entry) => entry.key === key)?.value ?? "") !== previous) {
    throw new Error("Your saved policy changed elsewhere. Discard this draft to load the current policy before editing again.");
  }
  if (inherited) {
    const source = await client.sys.config.get({ key: inherited.key });
    if ((source.entries.find((entry) => entry.key === inherited.key)?.value ?? "") !== inherited.value) {
      throw new Error("The inherited policy changed elsewhere. It has been reloaded; review your choice and try again.");
    }
  }
  await client.sys.config.set({ key, value });
}
