import type { KernelContext } from "../context";
import type {
  SysWorkspaceListArgs,
  SysWorkspaceListResult,
  SysWorkspaceSummary,
} from "../../syscalls/system";

export function handleSysWorkspaceList(
  args: SysWorkspaceListArgs | undefined,
  ctx: KernelContext,
): SysWorkspaceListResult {
  const identity = ctx.identity!;
  const requestedUid = args?.uid;
  const uid = typeof requestedUid === "number" ? requestedUid : identity.process.uid;

  if (requestedUid !== undefined && identity.process.uid !== 0 && requestedUid !== identity.process.uid) {
    throw new Error(`Permission denied: cannot list workspaces for uid ${requestedUid}`);
  }

  const kind = args?.kind;
  const state = args?.state;
  const limit = typeof args?.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
    ? Math.floor(args.limit)
    : null;

  const processes = ctx.procs
    .list(uid)
    .filter((record) => record.workspaceId !== null && record.state === "running");
  const processesByWorkspace = new Map<string, typeof processes>();
  for (const process of processes) {
    if (!process.workspaceId) {
      continue;
    }
    const existing = processesByWorkspace.get(process.workspaceId) ?? [];
    existing.push(process);
    processesByWorkspace.set(process.workspaceId, existing);
  }

  let workspaces = ctx.workspaces.list(uid).map((workspace): SysWorkspaceSummary => {
    const running = (processesByWorkspace.get(workspace.workspaceId) ?? [])
      .slice()
      .sort((left, right) => right.createdAt - left.createdAt);
    const active = running[0] ?? null;

    return {
      workspaceId: workspace.workspaceId,
      ownerUid: workspace.ownerUid,
      label: workspace.label,
      kind: workspace.kind,
      state: workspace.state,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      defaultBranch: workspace.defaultBranch,
      headCommit: workspace.headCommit,
      activeProcess: active
        ? {
            pid: active.processId,
            label: active.label,
            cwd: active.cwd,
            createdAt: active.createdAt,
          }
        : null,
      processCount: running.length,
    };
  });

  if (kind) {
    workspaces = workspaces.filter((workspace) => workspace.kind === kind);
  }

  if (state) {
    workspaces = workspaces.filter((workspace) => workspace.state === state);
  }

  if (limit !== null) {
    workspaces = workspaces.slice(0, limit);
  }

  return { workspaces };
}
