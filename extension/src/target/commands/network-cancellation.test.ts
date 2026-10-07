import { describe, expect, it, vi } from "vitest";
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
});
