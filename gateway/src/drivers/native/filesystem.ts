import {
  createAccountHomeBackend,
  createPackageBackend,
  createProcessSourceBackend,
  RipgitClient,
  requestProcessView,
} from "../../fs";
import { GsvFs } from "../../fs/gsv-fs";
import type { KernelContext } from "../../kernel/context";
import { resolveCallerOwnerUid } from "../../kernel/context";
import { createCronFileService } from "../../kernel/crontab";
import { handleRepoList } from "../../kernel/repo";
import { r2ObjectLimit } from "../../fs/storage-policy";

export function createNativeFileSystem(ctx: KernelContext): GsvFs {
  const identity = ctx.identity!.process;
  const ownerUid = resolveCallerOwnerUid(ctx);
  const maxR2ObjectBytes = r2ObjectLimit(ctx.env);
  const sourceBackend = createProcessSourceBackend({
    identity,
    storage: ctx.env.STORAGE,
    ripgit: ctx.env.RIPGIT ? new RipgitClient(ctx.env.RIPGIT) : null,
    repos: handleRepoList(undefined, ctx).repos,
    processId: ctx.processId ?? null,
    config: ctx.config,
    maxR2ObjectBytes,
  });

  return new GsvFs(
    ctx.env.STORAGE,
    identity,
    {
      auth: ctx.auth,
      procs: ctx.procs,
      conversations: ctx.conversations,
      devices: ctx.devices,
      caps: ctx.caps,
      config: ctx.config,
      packages: ctx.packages,
      cron: createCronFileService(ctx),
      schedules: ctx.schedules,
      processRequest: requestProcessView,
    },
    ctx.processId ?? undefined,
    sourceBackend,
    createAccountHomeBackend(ctx.env.STORAGE, ctx.env.RIPGIT, identity, {
      auth: ctx.auth,
      ownerUid,
      isRoot: identity.uid === 0,
      maxR2ObjectBytes,
    }),
    createPackageBackend(identity, ctx.packages, { uid: ownerUid }),
    maxR2ObjectBytes,
  );
}
