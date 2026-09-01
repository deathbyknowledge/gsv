import type { JsonValue, SyscallName } from "@humansandmachines/gsv/protocol";
import type { ToolDefinition } from "@humansandmachines/gsv/protocol";

export type {
  ArgsOf,
  ResultOf,
  SyscallDomains,
  SyscallName,
} from "@humansandmachines/gsv/protocol";
export type { ToolDefinition } from "@humansandmachines/gsv/protocol";

type SyscallDomain =
  | "fs"
  | "shell"
  | "net"
  | "codemode"
  | "mail"
  | "proc"
  | "repo"
  | "sys"
  | "ai"
  | "sched"
  | "r12y"
  | "adapter"
  | "signal"
  | "account";

type SyscallInputSchema = {
  required: string[];
  properties: Record<string, JsonValue>;
};

function parseSyscallInputSchema(inputSchema: ToolDefinition["inputSchema"]): SyscallInputSchema {
  // SAFETY: ToolDefinition input schemas are produced by the protocol schema boundary.
  return inputSchema as SyscallInputSchema;
}

function domainOf(syscall: SyscallName): SyscallDomain {
  // SAFETY: SyscallName is constructed from the finite domain prefixes above.
  return syscall.split(".")[0] as SyscallDomain;
}

/**
 * Domains that support environment routing via the `target` field.
 * `shell` and `fs` can run in the native GSV environment or a registered target.
 * `net` can exit from the Gateway Worker or another target's network position.
 * `proc` is a Kernel control-plane domain and is not target-routed.
 */
const ROUTABLE_DOMAINS: SyscallDomain[] = ["fs", "shell", "net"];
const TARGET_SCHEMA_DESCRIPTION = "Target to execute on. Use \"gsv\" for the native cloud target, or preserve the exact target from an authorized file reference. Run `targets list` in Shell to inspect accessible targets and their current online status.";

/**
 * Inject a `target` property into a tool definition so the LLM can choose
 * where to execute the syscall. Only applicable to target-routable domains.
 *
 * @param tool - The base tool definition (without target)
 */
export function intoSyscallTool(
  tool: ToolDefinition,
): ToolDefinition {
  const { required, properties } = parseSyscallInputSchema(tool.inputSchema);
  if (
    required.includes("target") ||
    Object.keys(properties).includes("target")
  ) {
    throw new Error(
      `Tool ${tool.name} already has 'target' property. Can't turn into syscall tool.`,
    );
  }

  const targetRequired = tool.name !== "Shell";

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: "object",
      properties: {
        ...properties,
        target: {
          type: "string",
          description: TARGET_SCHEMA_DESCRIPTION,
        },
      },
      required: targetRequired ? [...required, "target"] : required,
    },
  };
}

export function isRoutableSyscall(call: SyscallName): boolean {
  return ROUTABLE_DOMAINS.includes(domainOf(call));
}
