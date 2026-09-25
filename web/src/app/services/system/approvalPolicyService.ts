import type { GSVClient } from "@humansandmachines/gsv/client";
import { readSettingsPolicy } from "../../features/instrument/settings/settingsModel";

/** The account's approval override; blank means the inherited policy. */
export function accountApprovalKey(uid: number): string {
  return `users/${uid}/ai/tools/approval`;
}

/** Whether the first-approval walkthrough has been done or skipped; blank means not yet. */
export function approvalSetupKey(uid: number): string {
  return `users/${uid}/ui/approval-setup`;
}

export type ApprovalSetupMark = "done" | "skipped";

/** Replace the account policy only if it still reads as the draft's base; blank returns to inheritance. */
export async function saveAccountApprovalPolicy(client: Pick<GSVClient, "sys">, uid: number, previous: string, value: string): Promise<void> {
  if (value && !readSettingsPolicy(value)) throw new Error("The replacement policy is not valid. Review its rules before saving.");
  const key = accountApprovalKey(uid);
  const current = await client.sys.config.get({ key });
  if ((current.entries.find((entry) => entry.key === key)?.value ?? "") !== previous) {
    throw new Error("Your saved policy changed elsewhere. Discard this draft to load the current policy before editing again.");
  }
  await client.sys.config.set({ key, value });
}

/** Record the walkthrough outcome; blank clears the mark so it shows again at the next approval. */
export async function markApprovalSetup(client: Pick<GSVClient, "sys">, uid: number, mark: ApprovalSetupMark | ""): Promise<void> {
  await client.sys.config.set({ key: approvalSetupKey(uid), value: mark });
}
