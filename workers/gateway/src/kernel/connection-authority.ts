import type { AuthStore } from "./auth-store";
import { hasCapability, type CapabilityStore } from "./capabilities";
import type { KernelConnection, KernelConnectionState } from "./connection";

/** Recheck owned credentials at ingress, egress, and hibernation recovery. */
export function connectionCredentialIsCurrent(
  connection: Pick<KernelConnection<KernelConnectionState>, "state" | "origin">,
  auth: AuthStore,
  caps: CapabilityStore,
  installationId: string,
): boolean {
  const state = connection.state;
  if (state.step !== "connected" || !state.peer) return false;
  const { principal, grant } = state.peer;
  const uid = principal.account.uid;
  if ((state.credentialEpoch ?? 0) !== auth.credentialEpoch(uid) || auth.isAccountDisabled(uid)) return false;
  if (state.credentialMethod !== "token") return true;
  // Old token attachments must reconnect to recover the credential identity.
  if (!state.token) return false;
  const token = auth.tokenAuthority(state.token.tokenId, uid, { installationId, origin: connection.origin });
  if (!token || token.kind !== principal.kind || (token.peerId !== null && token.peerId !== state.peer.id)
    || JSON.stringify(token) !== JSON.stringify(state.token)) return false;
  if (!token.ceiling) return true;
  const account = auth.getPasswdByUid(uid);
  if (!account) return false;
  const currentCalls = caps.resolve(auth.resolveGids(account.username, account.gid));
  return grant.implements.length === 0
    && grant.calls.every(call => token.ceiling!.calls.some(allowed => allowed === call) && hasCapability(currentCalls, call))
    && grant.signals.every(signal => token.ceiling!.signals.some(allowed => allowed === signal))
    && (grant.signals.length === 0 || hasCapability(currentCalls, "r12y.list"));
}
