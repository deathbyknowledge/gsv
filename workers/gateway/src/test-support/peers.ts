import type { PeerPrincipalKind, ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { PeerContext } from "../kernel/peer";

/** A credential-authenticated peer for handler tests: who is acting, as which account, with which calls. */
export function testPeer(input: {
  kind?: PeerPrincipalKind;
  account: ProcessIdentity;
  calls?: string[];
  peerId?: string;
}): PeerContext {
  const kind = input.kind ?? "human";
  const id = input.peerId ?? `${kind}:${input.account.username}`;
  return {
    installationId: "singleton",
    peer: {
      id,
      sessionId: `session:${id}`,
      principal: { kind, account: input.account },
      grant: { calls: input.calls ?? [], signals: [], implements: [] },
    },
    transport: { kind: "websocket", connectionId: `session:${id}` },
    provenance: { kind: "credential", method: "token" },
  };
}
