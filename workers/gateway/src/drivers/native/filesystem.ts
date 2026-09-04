import {
  createAccountHomeBackend,
  createProcessSourceBackend,
  createProcessViewRequest,
  RipgitClient,
} from "../../fs";
import { GsvFs } from "../../fs/gsv-fs";
import type { KernelContext } from "../../kernel/context";
import { requirePrincipal } from "../../kernel/context";
import { resolveCallerOwnerUid } from "../../kernel/context";
import { createCronFileService } from "../../kernel/crontab";
import { handleRepoList } from "../../kernel/repo";

export function createNativeFileSystem(ctx: KernelContext): GsvFs {
  const identity = requirePrincipal(ctx).account;
  const ownerUid = resolveCallerOwnerUid(ctx);
  const sourceBackend = createProcessSourceBackend({
    identity,
    ripgit: ctx.env.RIPGIT ? new RipgitClient(ctx.env.RIPGIT) : null,
    repos: handleRepoList(undefined, ctx).repos,
  });

  return new GsvFs(
    ctx.env.STORAGE,
    identity,
    {
      auth: ctx.auth,
      procs: ctx.procs,
      targets: ctx.targets,
      caps: ctx.caps,
      config: ctx.config,
      cron: createCronFileService(ctx),
      schedules: ctx.schedules,
      processRequest: createProcessViewRequest(ctx.installationId),
    },
    ctx.processId ?? undefined,
    sourceBackend,
    createAccountHomeBackend(ctx.env.STORAGE, ctx.env.RIPGIT, identity, {
      auth: ctx.auth,
      ownerUid,
      isRoot: identity.uid === 0,
    }),
  );
}
