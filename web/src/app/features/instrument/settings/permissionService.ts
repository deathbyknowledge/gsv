import type { GSVClient } from "@humansandmachines/gsv/client";
import { readSettingsPolicy } from "./settingsModel";
import { t } from "../../../i18n/locale";

export async function saveApprovalPolicy(client: Pick<GSVClient, "sys">, uid: number, previous: string, value: string): Promise<void> {
  if (value && !readSettingsPolicy(value)) throw new Error(t("settings.permissions.replacementInvalid"));
  const key = `users/${uid}/ai/tools/approval`;
  const current = await client.sys.config.get({ key });
  if ((current.entries.find((entry) => entry.key === key)?.value ?? "") !== previous) {
    throw new Error(t("settings.permissions.changedElsewhere"));
  }
  await client.sys.config.set({ key, value });
}
