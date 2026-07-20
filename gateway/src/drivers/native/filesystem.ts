import {
  createAccountHomeBackend,
  createPackageBackend,
  createProcessSourceBackend,
  RipgitClient,
  requestProcessView,
} from "../../fs";
import { GsvFs } from "../../fs/gsv-fs";
import type { KernelRefs } from "../../fs/refs";
import type { KernelContext } from "../../kernel/context";
import { resolveCallerOwnerUid } from "../../kernel/context";
import { createCronFileService } from "../../kernel/crontab";

export function createNativeFileSystem(ctx: KernelContext): GsvFs {
  const identity = ctx.identity!.process;
  const ownerUid = resolveCallerOwnerUid(ctx);
  const sourceBackend = createProcessSourceBackend({
    identity,
    storage: ctx.env.STORAGE,
    ripgit: ctx.env.RIPGIT ? new RipgitClient(ctx.env.RIPGIT) : null,
    listRepos: async () => (await ctx.listRepos()).repos,
    processId: ctx.processId ?? null,
    config: ctx.config,
  });

  const kernelRefs: KernelRefs = {
    auth: {
      readAuthFile: (kind) => ctx.readAuthFile(kind),
      getAccountByUsername: async (username) => {
        const account = await ctx.accountGet({ username });
        return account
          ? {
              uid: account.uid,
              gid: account.gid,
              username: account.username,
              home: account.home,
            }
          : null;
      },
      getPersonalAgentUid: async (uid) => {
        const account = await ctx.accountGet({ uid });
        return account?.personalAgentUid ?? null;
      },
      authDirectoryWritable: ctx.kernelKind === "master",
      ...(ctx.kernelKind === "master"
        ? {
            importAuthFile: (kind, content) => {
              if (kind === "passwd") ctx.auth.importPasswd(content);
              else if (kind === "shadow") ctx.auth.importShadow(content);
              else ctx.auth.importGroup(content);
            },
          }
        : {}),
    },
    procs: ctx.procs,
    conversations: ctx.conversations,
    devices: ctx.devices,
    caps: {
      list: (gid) => ctx.capsList(gid),
    },
    config: {
      get: (key) => ctx.configGet(key),
      list: (prefix) => ctx.configList(prefix),
    },
    writeConfig: ctx.writeConfig,
    packages: {
      listVisible: (options) => ctx.packagesList(options),
    },
    cron: createCronFileService(ctx),
    schedules: ctx.schedules,
    processRequest: requestProcessView,
  };

  return new GsvFs(
    ctx.env.STORAGE,
    identity,
    kernelRefs,
    ctx.processId ?? undefined,
    sourceBackend,
    createAccountHomeBackend(ctx.env.STORAGE, ctx.env.RIPGIT, identity, {
      getAccount: (username) => ctx.accountGet({ username }),
      isRoot: identity.uid === 0,
    }),
    createPackageBackend(identity, kernelRefs.packages),
  );
}
