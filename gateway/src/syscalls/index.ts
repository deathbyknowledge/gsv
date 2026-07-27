import type { SyscallName } from "@humansandmachines/gsv/protocol";
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
  | "app"
  | "codemode"
  | "proc"
  | "pkg"
  | "repo"
  | "sys"
  | "ai"
  | "sched"
  | "notification"
  | "adapter"
  | "signal"
  | "account";

function domainOf(syscall: SyscallName): SyscallDomain {
  return syscall.split(".")[0] as SyscallDomain;
}

/**
 * Domains that support device routing via the `target` field.
 * `shell` always requires a device target. `fs` can be native (R2) or device.
 * `net` can exit either from the gateway Worker or from a connected device.
 * `proc` is kernel-internal (no device routing).
 */
const ROUTABLE_DOMAINS: SyscallDomain[] = ["fs", "shell", "net"];
const TARGET_SCHEMA_INLINE_LIMIT = 10;

/**
 * Inject a `target` property into a tool definition so the LLM can choose
 * where to execute the syscall. Only applicable to routable domains (fs, shell).
 *
 * @param tool - The base tool definition (without target)
 * @param devices - List of accessible online device IDs for this user
 */
export function intoSyscallTool(
  tool: ToolDefinition,
  devices: string[],
): ToolDefinition {
  const required = tool.inputSchema.required as string[];
  const properties = tool.inputSchema.properties as Record<string, unknown>;
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
          description: formatTargetSchemaDescription(devices),
        },
      },
      required: targetRequired ? [...required, "target"] : required,
    },
  };
}

function formatTargetSchemaDescription(devices: string[]): string {
  if (devices.length === 0) {
    return "Target to execute on. Use \"gsv\" for the native cloud target. Run `targets list` in Shell to discover connected targets.";
  }
  const listed = devices.slice(0, TARGET_SCHEMA_INLINE_LIMIT);
  const suffix = devices.length > listed.length
    ? `, and ${devices.length - listed.length} more`
    : "";
  return `Target to execute on. Use "gsv" for the native cloud target, or one of: ${listed.join(", ")}${suffix}. Run \`targets list\` in Shell for details.`;
}

export function isRoutableSyscall(call: SyscallName): boolean {
  return ROUTABLE_DOMAINS.includes(domainOf(call));
}
