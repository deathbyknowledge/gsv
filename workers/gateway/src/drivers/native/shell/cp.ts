import type { ExecResult } from "just-bash";
import { defineCommand } from "./command";
import type { KernelContext } from "../../../kernel/context";
import { handleFsCopy, type FsDeviceTransport } from "../fs";
import { parseShellFsEndpoint } from "./fs-path";

export function buildCpCommand(
  kernelCtx: KernelContext,
  transport?: FsDeviceTransport,
) {
  return defineCommand("cp", async (args, ctx): Promise<ExecResult> => {
    if (args.includes("--help")) {
      return {
        stdout: [
          "cp SOURCE DEST",
          "",
          "Copy one file locally or across targets.",
          "Paths may be local, gsv:/path, target:/path, or [target-with-colons]:/path.",
          "",
          "Examples:",
          "  cp rearden:/home/hank/report.pdf /tmp/report.pdf",
          "  cp /tmp/report.pdf [rearden:brave]:/tmp/report.pdf",
          "",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      };
    }

    const operands = args.filter((arg) => arg !== "--");
    const unsupported = operands.find((arg) => arg.startsWith("-"));
    if (unsupported) {
      return {
        stdout: "",
        stderr: `cp: unsupported option '${unsupported}'\n`,
        exitCode: 1,
      };
    }
    if (operands.length < 2) {
      return {
        stdout: "",
        stderr: "cp: missing destination file operand\n",
        exitCode: 1,
      };
    }
    if (operands.length > 2) {
      return {
        stdout: "",
        stderr: "cp: multiple source files are not supported yet\n",
        exitCode: 1,
      };
    }

    const source = parseShellFsEndpoint(operands[0], ctx, kernelCtx);
    const destination = parseShellFsEndpoint(operands[1], ctx, kernelCtx);

    try {
      const result = await handleFsCopy(
        {
          source,
          destination,
        },
        kernelCtx,
        transport,
      );
      if (!result.ok) {
        return { stdout: "", stderr: `cp: ${result.error}\n`, exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { stdout: "", stderr: `cp: ${msg}\n`, exitCode: 1 };
    }
  });
}
