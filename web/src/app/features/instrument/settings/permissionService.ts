import type { GSVClient } from "@humansandmachines/gsv/client";
import { readSettingsPolicy } from "./settingsModel";

export async function saveApprovalPolicy(client: Pick<GSVClient, "sys">, uid: number, previous: string, value: string): Promise<void> {
  if (value && !readSettingsPolicy(value)) throw new Error("The replacement policy is not valid. Review its rules before saving.");
  const key = `users/${uid}/ai/tools/approval`;
  const current = await client.sys.config.get({ key });
  if ((current.entries.find((entry) => entry.key === key)?.value ?? "") !== previous) {
    throw new Error("Your saved policy changed elsewhere. Discard this draft to load the current policy before editing again.");
  }
  await client.sys.config.set({ key, value });
}
