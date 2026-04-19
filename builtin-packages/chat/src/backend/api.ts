type KernelClient = {
  request(call: string, args: Record<string, unknown>): Promise<any>;
};

function normalizeArgs(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function normalizePid(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function normalizeLimit(value: unknown, fallback = 50) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export async function listProfiles(kernel: KernelClient, input: unknown) {
  return kernel.request("proc.profile.list", normalizeArgs(input));
}

export async function listWorkspaces(kernel: KernelClient, input: unknown) {
  const args = normalizeArgs(input);
  return kernel.request("sys.workspace.list", {
    kind: "thread",
    ...args,
  });
}

export async function spawnProcess(kernel: KernelClient, input: unknown) {
  return kernel.request("proc.spawn", normalizeArgs(input));
}

export async function sendMessage(kernel: KernelClient, input: unknown) {
  const args = normalizeArgs(input);
  const message = typeof args.message === "string" ? args.message : "";
  const pid = normalizePid(args.pid);
  const media = Array.isArray(args.media) ? args.media : [];
  return kernel.request("proc.send", {
    message,
    ...(pid ? { pid } : {}),
    ...(media.length > 0 ? { media } : {}),
  });
}

export async function getHistory(kernel: KernelClient, input: unknown) {
  const args = normalizeArgs(input);
  const pid = normalizePid(args.pid);
  const offset = typeof args.offset === "number" && Number.isFinite(args.offset) ? Math.floor(args.offset) : undefined;
  return kernel.request("proc.history", {
    limit: normalizeLimit(args.limit, 50),
    ...(pid ? { pid } : {}),
    ...(typeof offset === "number" ? { offset } : {}),
  });
}

export async function abortRun(kernel: KernelClient, input: unknown) {
  const pid = normalizePid(normalizeArgs(input).pid);
  return kernel.request("proc.abort", { pid });
}

export async function decideHil(kernel: KernelClient, input: unknown) {
  const args = normalizeArgs(input);
  const decision = args.decision === true
    ? "approve"
    : args.decision === false
      ? "deny"
      : typeof args.decision === "string"
        ? args.decision.trim()
        : "";
  return kernel.request("proc.hil", {
    pid: normalizePid(args.pid),
    requestId: typeof args.requestId === "string" ? args.requestId : "",
    decision,
  });
}
