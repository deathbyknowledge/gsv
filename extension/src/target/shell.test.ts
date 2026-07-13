import { afterEach, describe, expect, it, vi } from "vitest";
import { pageCommand } from "./commands/page";
import { BrowserTargetShell } from "./shell";
import type { BrowserCommand, CommandResult, TargetFileSystem } from "./types";

afterEach(() => vi.unstubAllGlobals());

describe("BrowserTargetShell", () => {
  it("stops a running command when its request is cancelled", async () => {
    const shell = new BrowserTargetShell(directoryOnlyFileSystem(), []);
    const controller = new AbortController();
    const execution = shell.exec({ input: "sleep 300" }, { abortSignal: controller.signal });

    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(new Error("User interrupted"));

    await expect(Promise.race([
      execution,
      new Promise((_, reject) => setTimeout(() => reject(new Error("shell did not stop")), 1_000)),
    ])).resolves.toMatchObject({ status: "failed" });
  });

  it("drops a cancelled queued command without bypassing the active command", async () => {
    const running = deferred<void>();
    const started = deferred<void>();
    let laterRuns = 0;
    const commands: BrowserCommand[] = [
      {
        name: "block",
        summary: "Block until released.",
        async run() {
          started.resolve(undefined);
          await running.promise;
          return commandResult();
        },
      },
      {
        name: "later",
        summary: "Record execution.",
        run() {
          laterRuns += 1;
          return commandResult();
        },
      },
    ];
    const shell = new BrowserTargetShell(directoryOnlyFileSystem(), commands);
    const active = shell.exec({ input: "block" });
    await expect(within(Promise.race([
      started.promise.then(() => "started"),
      active.then(() => "finished"),
    ]))).resolves.toBe("started");

    const controller = new AbortController();
    const cancelled = shell.exec({ input: "later" }, { abortSignal: controller.signal });
    const next = shell.exec({ input: "later" });
    controller.abort(new Error("Route expired"));

    await expect(within(cancelled)).resolves.toMatchObject({
      status: "failed",
      error: "Route expired",
    });
    expect(laterRuns).toBe(0);

    running.resolve(undefined);
    await expect(active).resolves.toMatchObject({ status: "completed" });
    await expect(within(next)).resolves.toMatchObject({ status: "completed" });
    expect(laterRuns).toBe(1);
  });

  it("cancels a long page wait, stops polling, and runs the next command", async () => {
    const firstPoll = deferred<void>();
    const executeScript = vi.fn(async () => {
      firstPoll.resolve(undefined);
      return [{ result: { ok: true, value: null } }];
    });
    vi.stubGlobal("chrome", {
      tabs: {
        query: async () => [{
          id: 1,
          windowId: 1,
          index: 0,
          active: true,
          highlighted: true,
          pinned: false,
        }],
      },
      scripting: { executeScript },
    });

    const shell = new BrowserTargetShell(directoryOnlyFileSystem(), [pageCommand]);
    const controller = new AbortController();
    const waiting = shell.exec(
      { input: "page wait '#never' --timeout 120000" },
      { abortSignal: controller.signal },
    );
    await expect(within(Promise.race([
      firstPoll.promise.then(() => "started"),
      waiting.then(() => "finished"),
    ]))).resolves.toBe("started");

    const next = shell.exec({ input: "help" });
    controller.abort(new Error("Route expired"));

    await expect(within(waiting)).resolves.toMatchObject({ status: "failed" });
    await expect(within(next)).resolves.toMatchObject({ status: "completed" });
    const pollsAfterCancellation = executeScript.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(executeScript).toHaveBeenCalledTimes(pollsAfterCancellation);
  });
});

function commandResult(): CommandResult {
  return { stdout: "", stderr: "", exitCode: 0 };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("operation did not stop")), 1_000)),
  ]);
}

function directoryOnlyFileSystem(): TargetFileSystem {
  return {
    read: async () => { throw new Error("No such file"); },
    write: async () => {},
    append: async () => {},
    delete: async () => {},
    mkdir: async () => {},
    copy: async (_source, destination) => destination,
    move: async () => {},
    list: async () => ({ files: [], directories: [] }),
    stat: async (path) => ({ path, isFile: false, isDirectory: true, size: 0 }),
    exists: async (path) => path === "/",
    search: async () => [],
    resolvePath: (_cwd, path) => path.startsWith("/") ? path : `/${path}`,
    getAllPaths: async () => ["/"],
  };
}
