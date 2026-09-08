import { defineCommand, type ExecResult } from "just-bash";
import type { KernelContext } from "../../../kernel/context";
import { handleSignalUnwatch, handleSignalWatch } from "../../../kernel/signals";
import { decodeWireFrameJson } from "../../../protocol/decode-wire-frame";
import { requireCommandCapability } from "./common";

export function buildSignalCommand(ctx: KernelContext) {
  return defineCommand("signal", async (args): Promise<ExecResult> => {
    try {
      const [command = "help", option, source] = args;
      if (command === "help" || command === "--help" || command === "-h") {
        return {
          stdout: [
            "Usage: signal watch --json JSON | signal unwatch --json JSON",
            "",
            "Uses the signal.watch and signal.unwatch syscall arguments for this Process.",
            "Watch exactly one processId or targetId. Target watches use target.status,",
            "default to person-only notices, and may explicitly request audience model or both.",
            "Use once:false for repeated notifications; watches expire after ttlMs (default one day).",
            "Unwatch by watchId or key. Requires the corresponding signal capability.",
            "",
          ].join("\n"), stderr: "", exitCode: 0,
        };
      }
      if ((command !== "watch" && command !== "unwatch") || option !== "--json" || !source || args.length !== 3) {
        throw new Error("expected signal watch --json JSON or signal unwatch --json JSON");
      }
      const call = command === "watch" ? "signal.watch" : "signal.unwatch";
      requireCommandCapability(ctx, call);
      // Shell JSON is an ingress boundary; reuse the syscall's generated argument contract.
      const frame = decodeWireFrameJson(JSON.stringify({
        type: "req", id: crypto.randomUUID(), call, args: JSON.parse(source),
      }));
      if (frame.type !== "req") throw new Error("Expected a signal request");
      switch (frame.call) {
        case "signal.watch":
          return { stdout: `${JSON.stringify(handleSignalWatch(frame.args, ctx))}\n`, stderr: "", exitCode: 0 };
        case "signal.unwatch":
          return { stdout: `${JSON.stringify(handleSignalUnwatch(frame.args, ctx))}\n`, stderr: "", exitCode: 0 };
        default:
          throw new Error("Expected a signal request");
      }
    } catch (error) {
      return { stdout: "", stderr: `signal: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }
  });
}
