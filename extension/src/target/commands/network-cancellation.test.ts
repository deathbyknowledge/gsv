import { describe, expect, it, vi } from "vitest";
import { BrowserTargetFileSystem } from "../fs";
import type { CommandContext, TargetFileSystem } from "../types";
import { networkCommand } from "./network";

describe("network export cancellation", () => {
  it("does not write a HAR file after Pause interrupts collection", async () => {
    const controller = new AbortController();
    const write = vi.fn();
    const ctx: CommandContext = {
      cwd: "/",
      stdin: "",
      fs: {
        resolvePath: (_cwd: string, path: string) => path,
        write,
      } as unknown as TargetFileSystem,
      now: () => 0,
      abortSignal: controller.signal,
    };

    const running = networkCommand.run(["export", "har", "--path", "/tmp/capture.har"], ctx);
    controller.abort(new Error("Browser access paused"));
    const result = await running;

    expect(result.exitCode).toBe(1);
    expect(write).not.toHaveBeenCalled();
  });

  it("does not persist a HAR file when Pause interrupts filesystem acquisition", async () => {
    let finishExists!: (exists: boolean) => void;
    const pendingExists = new Promise<boolean>((resolve) => { finishExists = resolve; });
    const exists = vi.fn((path: string) => path === "/tmp/capture.har" ? pendingExists : Promise.resolve(false));
    const runtime = { exists, getAllPaths: async () => [] } as unknown as TargetFileSystem;
    const fs = new BrowserTargetFileSystem(runtime);
    const controller = new AbortController();
    const ctx: CommandContext = {
      cwd: "/",
      stdin: "",
      fs,
      now: () => 0,
      abortSignal: controller.signal,
    };

    const running = networkCommand.run(["export", "har", "--path", "/tmp/capture.har"], ctx);
    await vi.waitFor(() => expect(exists).toHaveBeenCalledWith("/tmp/capture.har"));
    controller.abort(new Error("Browser access paused"));
    finishExists(false);

    expect((await running).exitCode).toBe(1);
    await expect(fs.exists("/tmp/capture.har")).resolves.toBe(false);
  });
});
