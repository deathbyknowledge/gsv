import { siteIdSchema, type SiteAuthorization, type SiteAuthorizeArgs } from "@humansandmachines/gsv/protocol";
import { hasCapability } from "./capabilities";
import { connectionCredentialIsCurrent } from "./connection-authority";
import type { KernelContext } from "./context";
import { SITE_READ_CALLS, SITE_READ_SIGNALS } from "./token-authority";

const SITE_TOKEN_TTL_MS = 60 * 60 * 1000;

export async function handleSiteAuthorize(args: SiteAuthorizeArgs, ctx: KernelContext): Promise<SiteAuthorization> {
  const ownerUid = consentOwner(ctx);
  const site = ctx.sites.get(ownerUid, siteIdSchema.parse(args.siteId));
  const expiresAt = Math.min(Date.now() + SITE_TOKEN_TTL_MS, ctx.connection!.state.token?.expiresAt ?? Infinity);
  const prepared = await ctx.auth.prepareToken({
    uid: ownerUid,
    kind: "human",
    label: `site:${site.id} ${site.origin}`,
    expiresAt,
    ceiling: {
      kind: "site",
      installationId: ctx.installationId,
      siteId: site.id,
      origin: site.origin,
      calls: [...SITE_READ_CALLS],
      signals: [...SITE_READ_SIGNALS],
      implements: [],
    },
  });
  ctx.requestSignal?.throwIfAborted();
  if (consentOwner(ctx) !== ownerUid || ctx.sites.get(ownerUid, site.id).origin !== site.origin) {
    throw new Error("Site authorization changed; try again");
  }
  const issued = ctx.auth.storePreparedToken(prepared);
  return {
    token: issued.token,
    tokenId: issued.tokenId,
    expiresAtMs: expiresAt,
    installationId: ctx.installationId,
    siteId: site.id,
    siteOrigin: site.origin,
    gatewayOrigin: ctx.installationIdentity!.canonicalOrigin,
    calls: [...SITE_READ_CALLS],
    signals: [...SITE_READ_SIGNALS],
  };
}

function consentOwner(ctx: KernelContext): number {
  const connection = ctx.connection;
  const peer = ctx.peer;
  const canonicalOrigin = ctx.installationIdentity?.canonicalOrigin;
  if (!connection || !peer || ctx.processId || peer.provenance.kind !== "credential"
    || peer.transport.kind !== "websocket" || peer.transport.connectionId !== connection.id
    || connection.state.token?.ceiling || !connection.state.credentialMethod
    || !canonicalOrigin || connection.origin !== canonicalOrigin || new URL(connection.uri).origin !== canonicalOrigin
    || !connectionCredentialIsCurrent(connection, ctx.auth, ctx.caps, ctx.installationId)) {
    throw new Error("Site authorization requires the owner in the trusted installation UI");
  }
  const account = connection.state.peer!.principal;
  if (account.kind !== "human" || account.account.uid !== ctx.auth.getHumanAccount()?.uid
    || peer.peer.principal.account.uid !== account.account.uid) {
    throw new Error("Only the publishing human owner can authorize a site");
  }
  const user = ctx.auth.getPasswdByUid(account.account.uid)!;
  const currentCalls = ctx.caps.resolve(ctx.auth.resolveGids(user.username, user.gid));
  if (!["site.authorize", ...SITE_READ_CALLS].every(call => hasCapability(peer.peer.grant.calls, call) && hasCapability(currentCalls, call))) {
    throw new Error("Site authorization requires site.authorize, r12y.list and r12y.get capabilities");
  }
  return account.account.uid;
}
