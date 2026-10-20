import type { GSVClient } from "@humansandmachines/gsv/client";
import type { ConsoleAdapter, ConsoleIdentityLink } from "../../../domain/system/consoleModels";
import { normalizeAdapterInventoryPayload, normalizeIdentityLinksPayload } from "../../../domain/system/consoleNormalization";

export type MessengerConnections = {
  adapters: ConsoleAdapter[];
  links: ConsoleIdentityLink[];
};

/** Whether a saved identity can currently exchange messages, as the Settings row presents it. */
export type MessengerConnectionStatus = "connected" | "reconnect-needed" | "needs-attention" | "status-unavailable" | "service-unavailable";

export async function loadMessengerConnections(client: Pick<GSVClient, "call">, uid: number): Promise<MessengerConnections> {
  const [inventory, identities] = await Promise.all([
    client.call("adapter.list", {}),
    client.call("sys.link.list", {}),
  ]);
  return {
    adapters: normalizeAdapterInventoryPayload(inventory),
    links: normalizeIdentityLinksPayload(identities).filter((link) => link.uid === uid),
  };
}

export function messengerConnectionStatus(adapter: ConsoleAdapter | undefined, accountId: string): MessengerConnectionStatus {
  if (!adapter?.available) return "service-unavailable";
  const account = adapter.accounts.find((entry) => entry.accountId === accountId);
  if (!account) return "status-unavailable";
  if (account.error) return "needs-attention";
  if (!account.connected || !account.authenticated) return "reconnect-needed";
  return "connected";
}
