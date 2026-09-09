import type { GSVClient } from "@humansandmachines/gsv";
import { createMachineNodeToken, type CreateMachineNodeTokenInput, type IssuedMachineNodeToken } from "../../gsv-console/backend/consoleService";

/** A cancelled, undisplayed credential remains this operation's responsibility. */
export async function issuePlacePairing(
  client: { sys: { token: Pick<GSVClient["sys"]["token"], "create" | "revoke"> } },
  input: CreateMachineNodeTokenInput,
  signal: AbortSignal,
): Promise<IssuedMachineNodeToken | null> {
  if (signal.aborted) return null;
  const issued = await createMachineNodeToken(client, input);
  if (!signal.aborted) return issued;
  await client.sys.token.revoke({ tokenId: issued.tokenId, reason: "Pairing cancelled before the key was displayed" });
  return null;
}

export function pairingOrigin(gatewayUrl: string): string {
  const url = new URL(gatewayUrl);
  if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol === "ws:") url.protocol = "http:";
  return url.origin;
}
