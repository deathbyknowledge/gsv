import type { ProcHilRequest } from "@humansandmachines/gsv/protocol";

export function normalizeHilRequest(value: unknown): ProcHilRequest | null {
  const record = asRecord(value);
  const pid = asString(record?.pid);
  const requestId = asString(record?.requestId);
  const runId = asString(record?.runId);
  const callId = asString(record?.callId);
  const toolName = asString(record?.toolName);
  const syscall = asString(record?.syscall);
  const target = asString(record?.target);
  if (!pid || !requestId || !runId || !callId || !toolName || !syscall || !target) {
    return null;
  }
  return {
    pid,
    requestId,
    runId,
    callId,
    toolName,
    syscall,
    target,
    args: asRecord(record?.args) ?? {},
    createdAt: asNumber(record?.createdAt) ?? Date.now(),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
