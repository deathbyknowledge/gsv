import type { TerminalCommandInput, TerminalTarget, TerminalTranscriptEntry } from "./models";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function normalizeTerminalTarget(target: string | null | undefined): string {
  const value = String(target ?? "").trim();
  return value.length > 0 ? value : "gsv";
}

export function normalizeTerminalTargets(payload: unknown): TerminalTarget[] {
  const record = asRecord(payload);
  const rawDevices = Array.isArray(payload) ? payload : Array.isArray(record?.devices) ? record.devices : [];
  const targets = rawDevices
    .map((device) => {
      const item = asRecord(device) ?? {};
      const id = asString(item.deviceId) ?? asString(item.id) ?? "";
      if (!id) {
        return null;
      }
      return {
        id,
        label: asString(item.label) ?? id,
        online: asBoolean(item.online) ?? false,
        platform: asString(item.platform) ?? "",
        description: asString(item.description) ?? "",
      };
    })
    .filter((target): target is TerminalTarget => target !== null)
    .sort((left, right) => left.id.localeCompare(right.id));

  return targets;
}

export function parseOptionalPositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeCommandInput(input: TerminalCommandInput): Required<Pick<TerminalCommandInput, "input">> & {
  target: string;
  sessionId: string;
  cwd: string;
  timeoutMs: number | null;
  yieldMs: number | null;
  background: boolean;
} {
  return {
    input: input.input.trim(),
    target: normalizeTerminalTarget(input.target),
    sessionId: String(input.sessionId ?? "").trim(),
    cwd: String(input.cwd ?? "").trim(),
    timeoutMs: parseOptionalPositiveInt(input.timeoutMs),
    yieldMs: parseOptionalPositiveInt(input.yieldMs),
    background: input.background === true,
  };
}

export function normalizeTranscriptEntry(
  payload: unknown,
  startedAt: number,
  input: ReturnType<typeof normalizeCommandInput>,
): TerminalTranscriptEntry {
  const completedAt = Date.now();
  const record = asRecord(payload);

  if (!record) {
    return {
      id: `${startedAt}-${completedAt}`,
      target: input.target,
      command: input.input,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      yieldMs: input.yieldMs,
      background: input.background,
      startedAt,
      completedAt,
      status: "completed",
      stdout: prettyJson(payload),
      stderr: "",
      exitCode: null,
      sessionId: null,
      truncated: false,
    };
  }

  const statusText = (asString(record.status) ?? "").toLowerCase();
  const errorText = asString(record.error);
  const exitCode = asNumber(record.exitCode);
  const stdout = asString(record.stdout) ?? asString(record.output) ?? "";
  let stderr = asString(record.stderr) ?? "";
  const explicitOk = asBoolean(record.ok);
  const backgrounded = input.background || asBoolean(record.backgrounded) === true || asBoolean(record.background) === true;
  const failed = explicitOk === false || statusText === "failed" || Boolean(errorText) || (exitCode !== null && exitCode !== 0);

  if (failed && stderr.trim().length === 0) {
    stderr = errorText ?? (exitCode !== null ? `exit ${exitCode}` : "");
  }

  return {
    id: `${startedAt}-${completedAt}`,
    target: input.target,
    command: input.input,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    yieldMs: input.yieldMs,
    background: backgrounded,
    startedAt,
    completedAt,
    status: statusText === "running" ? "running" : failed ? "failed" : "completed",
    stdout,
    stderr,
    exitCode,
    sessionId: (asString(record.sessionId) ?? input.sessionId) || null,
    truncated: asBoolean(record.truncated) ?? false,
  };
}
