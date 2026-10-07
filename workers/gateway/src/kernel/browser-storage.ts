import { BrowserStorageMountBackend } from "../fs/backends/browser-storage";
import { hasCapability } from "./capabilities";
import { principalOf, type KernelContext } from "./context";
import { acquireInstances, instanceActor, withInstances } from "./instance-service";
import { authorizeNestedOperation } from "./tool-approval";
import { raceWithAbort } from "../shared/abort";
import { withByteStreamFinalizer } from "../shared/streams";
import { cancelBinaryBody } from "@humansandmachines/gsv/protocol";

export function createBrowserStorageBackend(ctx: KernelContext): BrowserStorageMountBackend | null {
  if (!ctx.env.INSTANCES || principalOf(ctx)?.kind !== "human") return null;
  const actor = instanceActor(ctx);
  const account = ctx.auth.getPasswdByUid(actor.ownerUid);
  if (!account) return null;
  const requireCapability = (call: string) => {
    if (!hasCapability(principalOf(ctx)?.calls ?? [], call)) throw new Error(`EACCES: permission denied: ${call}`);
    ctx.requestSignal?.throwIfAborted();
  };
  return new BrowserStorageMountBackend({
    uid: account.uid, gid: account.gid, username: account.username,
    profile: async () => {
      requireCapability("sys.browser.profile.list");
      requireCapability("sys.browser.profile.get");
      const { profiles } = await withInstances(ctx, service => service.listProfiles(actor));
      return [...profiles].reverse().find(profile => profile.state === "active") ?? null;
    },
    read: async profileId => {
      requireCapability("sys.browser.profile.get");
      const signal = ctx.requestSignal ? AbortSignal.any([ctx.requestSignal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
      const service = await acquireInstances(ctx, signal);
      let transferred = false;
      try {
        const invocation = service.readProfileState(actor, profileId);
        const result = await raceWithAbort(invocation, signal, { onAbort: () => {
          transferred = true;
          ctx.defer(Promise.allSettled([invocation.then(late => cancelBinaryBody(late?.body, "Browser state read cancelled"))]).finally(() => service[Symbol.dispose]?.()));
        } });
        if (!result) return null;
        transferred = true;
        return { ...result, body: { ...result.body, stream: withByteStreamFinalizer(result.body.stream, () => service[Symbol.dispose]?.()) } };
      } finally { if (!transferred) service[Symbol.dispose]?.(); }
    },
    forget: async profileId => {
      requireCapability("sys.browser.profile.delete");
      await authorizeNestedOperation(ctx, "sys.browser.profile.delete", { profileId });
      ctx.requestSignal?.throwIfAborted();
      await withInstances(ctx, service => service.deleteProfile(actor, profileId));
    },
  });
}
