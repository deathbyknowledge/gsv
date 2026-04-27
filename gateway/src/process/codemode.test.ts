import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { executeCodeMode } from "./codemode";

describe("CodeMode executor", () => {
  it("runs with the Worker Loader binding and exposes shell and fs wrappers", async () => {
    const calls: Array<{ call: string; args: Record<string, unknown> }> = [];
    const result = await executeCodeMode(
      env,
      `
        const shellResult = await shell("npm test", { target: "gsv", cwd: "/workspace" });
        const readResult = await fs.read({ target: "gsv", path: "/workspace/package.json" });
        return {
          shellStatus: shellResult.status,
          shellOutput: shellResult.output,
          fileContent: readResult.content,
        };
      `,
      async (call, args) => {
        calls.push({ call, args });
        if (call === "shell.exec") {
          return { status: "completed", output: "ok", exitCode: 0 };
        }
        if (call === "fs.read") {
          return { ok: true, path: String(args.path), content: "file" };
        }
        throw new Error(`unexpected call: ${call}`);
      },
    );

    expect(calls).toEqual([
      {
        call: "shell.exec",
        args: { target: "gsv", cwd: "/workspace", input: "npm test" },
      },
      {
        call: "fs.read",
        args: { target: "gsv", path: "/workspace/package.json" },
      },
    ]);
    expect(result).toEqual({
      status: "completed",
      result: {
        shellStatus: "completed",
        shellOutput: "ok",
        fileContent: "file",
      },
    });
  });

  it("returns failed status when sandboxed code throws", async () => {
    const result = await executeCodeMode(
      env,
      "throw new Error('boom')",
      async () => null,
    );

    expect(result).toEqual({
      status: "failed",
      error: "boom",
    });
  });
});
