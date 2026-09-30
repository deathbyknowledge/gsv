import { defineCommand, type ExecResult } from "just-bash";
import { cancelBinaryBody } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../../../kernel/context";
import type { NativeShellCommandOptions } from "./commands";
import { requireCommandCapability, requireShellOptionValue } from "./common";
import { decodeShellStdin } from "./stdin";

export function buildFeedbackCommand(ctx: KernelContext, request?: NativeShellCommandOptions["request"]) {
  return defineCommand("feedback", async (args, shell): Promise<ExecResult> => {
    try {
      if (args.some((arg) => arg === "--help" || arg === "-h")) {
        return { stdout: "Usage: feedback [--id UUID] MESSAGE...\n       feedback [--id UUID] < report.txt\n", stderr: "", exitCode: 0 };
      }
      requireCommandCapability(ctx, "sys.feedback");
      let id: string | undefined;
      if (args[0] === "--id") { id = requireShellOptionValue(args[1], "--id"); args = args.slice(2); }
      if (args[0] === "--") args = args.slice(1);
      const message = args.length ? args.join(" ") : decodeShellStdin(shell.stdin);
      if (!request) throw new Error("direct syscall transport is unavailable");
      const response = await request({ type: "req", id: crypto.randomUUID(), call: "sys.feedback", args: { id, message } }, shell.signal);
      if (!response.ok) throw new Error(response.error.message);
      await cancelBinaryBody(response.body, "Feedback returns a receipt");
      return { stdout: `${JSON.stringify(response.data)}\n`, stderr: "", exitCode: 0 };
    } catch (error) {
      return { stdout: "", stderr: `feedback: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }
  });
}
