import type { KernelClientLike } from "@gsv/package/backend";
import type {
  KillRuntimeProcessArgs,
  KillRuntimeProcessResult,
  ProcessEntry,
  RuntimeState,
} from "../app/features/runtime/types";

function toProcessEntries(value: unknown): ProcessEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value as ProcessEntry[];
}

export async function loadRuntimeState(kernel: KernelClientLike): Promise<RuntimeState> {
  try {
    const payload = await kernel.request("proc.list", {});
    const record = payload && typeof payload === "object"
      ? payload as { processes?: unknown }
      : {};
    const processes = [...toProcessEntries(record.processes)]
      .sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0));

    return {
      processes,
      errorText: "",
    };
  } catch (error) {
    return {
      processes: [],
      errorText: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function killRuntimeProcess(
  kernel: KernelClientLike,
  args: KillRuntimeProcessArgs,
): Promise<KillRuntimeProcessResult> {
  const pid = String(args.pid ?? "").trim();
  if (!pid) {
    return {
      ok: false,
      errorText: "Process id is required.",
    };
  }

  try {
    await kernel.request("proc.kill", { pid });
    return {
      ok: true,
      errorText: "",
    };
  } catch (error) {
    return {
      ok: false,
      errorText: error instanceof Error ? error.message : String(error),
    };
  }
}
