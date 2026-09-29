import type { GSVClient } from "@humansandmachines/gsv/client";
import type { ConsoleAdapter, ConsoleIdentityLink } from "../../../domain/system/consoleModels";
import { normalizeAdapterInventoryPayload, normalizeIdentityLinksPayload } from "../../../domain/system/consoleNormalization";

export type MessengerConnections = {
  adapters: ConsoleAdapter[];
  links: ConsoleIdentityLink[];
};

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

export function messengerConnectionStatus(adapter: ConsoleAdapter | undefined, accountId: string): string {
  if (!adapter?.available) return "linked · service unavailable";
  const account = adapter.accounts.find((entry) => entry.accountId === accountId);
  if (!account) return "linked · status unavailable";
  if (account.error) return "linked · needs attention";
  if (!account.connected || !account.authenticated) return "linked · reconnect needed";
  return "connected";
}
