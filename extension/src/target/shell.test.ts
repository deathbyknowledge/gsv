import { describe, expect, it } from "vitest";
import { BrowserTargetShell } from "./shell";
import type { TargetFileSystem } from "./types";

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
});

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
    exists: async () => true,
    search: async () => [],
    resolvePath: (_cwd, path) => path.startsWith("/") ? path : `/${path}`,
    getAllPaths: async () => ["/"],
  };
}
