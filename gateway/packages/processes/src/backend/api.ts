import type { KillProcessArgs, KillProcessResult, ProcessEntry, ProcessesState } from "../app/types";

type KernelClient = {
  request(call: string, args: Record<string, unknown>): Promise<any>;
};

function toProcessEntries(value: unknown): ProcessEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value as ProcessEntry[];
}

export async function loadState(kernel: KernelClient): Promise<ProcessesState> {
  try {
    const payload = await kernel.request("proc.list", {});
    const processes = [...toProcessEntries(payload?.processes)]
      .sort((left, right) => Number(right?.createdAt ?? 0) - Number(left?.createdAt ?? 0));
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

export async function killProcess(kernel: KernelClient, args: KillProcessArgs): Promise<KillProcessResult> {
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
