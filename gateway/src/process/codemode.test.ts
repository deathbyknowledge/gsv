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

  it("applies command defaults and exposes argv and args", async () => {
    const calls: Array<{ call: string; args: Record<string, unknown> }> = [];
    const result = await executeCodeMode(
      env,
      `
        const shellResult = await shell("pwd");
        const readResult = await fs.read({ path: "package.json" });
        return { shellResult, readResult, argv, args };
      `,
      async (call, args) => {
        calls.push({ call, args });
        if (call === "shell.exec") {
          return { status: "completed", output: "/workspace\n", exitCode: 0 };
        }
        if (call === "fs.read") {
          return { ok: true, path: String(args.path), content: "{}" };
        }
        throw new Error(`unexpected call: ${call}`);
      },
      {
        defaultTarget: "gsv",
        defaultCwd: "/workspace",
        argv: ["one", "two"],
        args: { mode: "check" },
      },
    );

    expect(calls).toEqual([
      {
        call: "shell.exec",
        args: { target: "gsv", cwd: "/workspace", input: "pwd" },
      },
      {
        call: "fs.read",
        args: { target: "gsv", path: "/workspace/package.json" },
      },
    ]);
    expect(result).toEqual({
      status: "completed",
      result: {
        shellResult: { status: "completed", output: "/workspace\n", exitCode: 0 },
        readResult: { ok: true, path: "/workspace/package.json", content: "{}" },
        argv: ["one", "two"],
        args: { mode: "check" },
      },
    });
  });

  it("runs script bodies without relying on the package normalizer", async () => {
    const calls: Array<{ call: string; args: Record<string, unknown> }> = [];
    const result = await executeCodeMode(
      env,
      [
        "const res = await shell(\"pwd\");",
        "const file = await fs.read({ path: \"test.json\" });",
        "return { res, file, argv, args};",
      ].join("\n"),
      async (call, args) => {
        calls.push({ call, args });
        if (call === "shell.exec") {
          return { status: "completed", output: "/workspace\n", exitCode: 0 };
        }
        if (call === "fs.read") {
          return { ok: true, path: String(args.path), content: "{}" };
        }
        throw new Error(`unexpected call: ${call}`);
      },
      {
        defaultCwd: "/workspace",
        argv: ["one"],
        args: { mode: "body" },
      },
    );

    expect(calls).toEqual([
      {
        call: "shell.exec",
        args: { cwd: "/workspace", input: "pwd" },
      },
      {
        call: "fs.read",
        args: { path: "/workspace/test.json" },
      },
    ]);
    expect(result).toEqual({
      status: "completed",
      result: {
        res: { status: "completed", output: "/workspace\n", exitCode: 0 },
        file: { ok: true, path: "/workspace/test.json", content: "{}" },
        argv: ["one"],
        args: { mode: "body" },
      },
    });
  });

  it("strips invisible source characters from pasted scripts", async () => {
    const result = await executeCodeMode(
      env,
      "return { ok: true };\u200B",
      async () => null,
    );

    expect(result).toEqual({
      status: "completed",
      result: { ok: true },
    });
  });

  it("returns failed status for source syntax errors before dispatching tools", async () => {
    const calls: Array<{ call: string; args: Record<string, unknown> }> = [];
    const result = await executeCodeMode(
      env,
      "const res = await shell(\"pwd);",
      async (call, args) => {
        calls.push({ call, args });
        return null;
      },
    );

    expect(calls).toEqual([]);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("SyntaxError");
      expect(result.error).toContain("Invalid or unexpected token");
    }
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
