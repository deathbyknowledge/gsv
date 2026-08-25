import type { AppElementContext } from "../index";

export function openFilesForCurrentThread(context: AppElementContext): void {
  context.window.openApp("files");
}

export function openShellForExplicitThread(
  context: AppElementContext,
  thread: {
    pid: string;
    workspaceId: string | null;
    cwd: string;
  },
): void {
  context.window.openApp("shell", { thread });
}

export function closeCurrentWindow(context: AppElementContext): void {
  context.window.close();
}
