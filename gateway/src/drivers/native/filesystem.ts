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

export function createNativeFileSystem(ctx: KernelContext): GsvFs {
  const identity = ctx.identity!.process;
  const ownerUid = resolveCallerOwnerUid(ctx);
  const sourceBackend = createProcessSourceBackend({
    identity,
    storage: ctx.env.STORAGE,
    ripgit: ctx.env.RIPGIT ? new RipgitClient(ctx.env.RIPGIT) : null,
    repos: handleRepoList(undefined, ctx).repos,
    processId: ctx.processId ?? null,
    config: ctx.config,
  });

  return new GsvFs(
    ctx.env.STORAGE,
    identity,
    {
      auth: ctx.auth,
      authDirectoryWritable: ctx.kernelKind === "master",
      procs: ctx.procs,
      conversations: ctx.conversations,
      devices: ctx.devices,
      caps: ctx.caps,
      config: ctx.config,
      writeConfig: ctx.writeConfig,
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
    }),
    createPackageBackend(identity, ctx.packages, { uid: ownerUid }),
  );
}
