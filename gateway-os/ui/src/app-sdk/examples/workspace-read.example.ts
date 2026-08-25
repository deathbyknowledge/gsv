import type { AppElementContext } from "../index";

export function currentWorkspaceRoot(context: AppElementContext): string | null {
  return context.thread.current()?.workspace?.rootPath ?? null;
}

export async function readWorkspaceSummary(context: AppElementContext): Promise<unknown> {
  const workspaceRoot = currentWorkspaceRoot(context);
  if (!workspaceRoot) {
    return null;
  }

  return context.kernel.request("fs.read", {
    path: `${workspaceRoot}/.gsv/summary.md`,
  });
}
