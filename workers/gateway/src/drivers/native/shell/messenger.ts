import { defineCommand, type ExecResult } from "just-bash";
import type { KernelContext } from "../../../kernel/context";
import { handleAdapterList } from "../../../kernel/adapter-service";
import { handleAdapterPairInfo, handleAdapterPairInspect, handleAdapterPairConfirm } from "../../../kernel/adapter-pairing";
import { requireCommandCapability } from "./common";
import { decodeShellStdin } from "./stdin";

const USAGE = `Usage:
  messenger list
  messenger setup ADAPTER
  messenger inspect ADAPTER < code.txt
  messenger connect ADAPTER < code.txt

Ask the user to follow the setup instructions and paste the code in the conversation.
Save their code to a file and read it through stdin; keep it out of the logged command.
Connect redeems it for the process's human owner. Only report success after it returns paired: true.
`;

export function buildMessengerCommand(ctx: KernelContext) {
  return defineCommand("messenger", async (args, shell): Promise<ExecResult> => {
    try {
      if (args.some((arg) => arg === "--help" || arg === "-h") || args[0] === "help") {
        return { stdout: USAGE, stderr: "", exitCode: 0 };
      }
      const [action = "list", adapter, ...rest] = args;
      const requestSignal = ctx.requestSignal && shell.signal ? AbortSignal.any([ctx.requestSignal, shell.signal]) : ctx.requestSignal ?? shell.signal;
      const context = { ...ctx, requestSignal };
      requestSignal?.throwIfAborted();
      let result: unknown;
      if (action === "list" && !adapter) {
        requireCommandCapability(context, "adapter.list");
        result = await handleAdapterList({}, context);
      } else if (adapter && !rest.length && action === "setup") {
        requireCommandCapability(context, "adapter.pair.info");
        result = await handleAdapterPairInfo({ adapter }, context);
      } else if (adapter && !rest.length && (action === "inspect" || action === "connect")) {
        requireCommandCapability(context, action === "inspect" ? "adapter.pair.inspect" : "adapter.pair.confirm");
        const code = decodeShellStdin(shell.stdin).trim();
        if (!code) throw new Error("Read the pairing code from stdin: messenger connect ADAPTER < code.txt");
        result = action === "inspect"
          ? await handleAdapterPairInspect({ adapter, code }, context)
          : await handleAdapterPairConfirm({ adapter, code }, context);
      } else {
        throw new Error(USAGE.trim());
      }
      return { stdout: `${JSON.stringify(result)}\n`, stderr: "", exitCode: 0 };
    } catch (error) {
      return { stdout: "", stderr: `messenger: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }
  });
}
