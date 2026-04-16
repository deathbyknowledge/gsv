function asDeviceList(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object" && Array.isArray((value as { devices?: unknown[] }).devices)) {
    return (value as { devices: unknown[] }).devices;
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
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

function parseOptionalPositiveInt(raw: unknown): number | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function normalizeTarget(raw: unknown): string {
  const trimmed = String(raw ?? "").trim();
  return trimmed.length > 0 ? trimmed : "gsv";
}

function normalizeTranscriptEntry(payload: unknown, startedAt: number, target: string, command: string) {
  const completedAt = Date.now();
  const record = asRecord(payload);
  const entry = {
    id: `${startedAt}-${completedAt}`,
    target,
    command,
    stdout: "",
    stderr: "",
  };

  if (!record) {
    entry.stdout = prettyJson(payload);
    return entry;
  }

  const explicitOk = asBoolean(record.ok);
  const statusText = (asString(record.status) ?? "").toLowerCase();
  const exitCode = asNumber(record.exitCode);
  const stdout =
    asString(record.stdout) ??
    ((statusText === "completed" || statusText === "failed") ? asString(record.output) : null) ??
    "";
  const stderr = asString(record.stderr) ?? "";
  const errorText = asString(record.error);

  entry.stdout = stdout;
  entry.stderr = stderr;

  const backgrounded =
    asBoolean(record.backgrounded) === true ||
    (statusText === "running" && asString(record.sessionId) !== null);

  if (backgrounded) {
    entry.stdout = asString(record.output) ?? "Started in background.";
    entry.stderr = "";
    return entry;
  }

  if (explicitOk === false || statusText === "failed" || errorText) {
    entry.stderr = errorText ?? entry.stderr;
    return entry;
  }

  if (exitCode !== null && exitCode !== 0 && entry.stderr.trim().length === 0) {
    entry.stderr = `exit ${exitCode}`;
  }

  return entry;
}

function normalizeDevice(device: unknown) {
  const record = asRecord(device) ?? {};
  const deviceId = asString(record.deviceId) ?? asString(record.id) ?? "";
  const label = asString(record.label) ?? deviceId;
  const online = asBoolean(record.online) ?? false;
  return {
    deviceId,
    label,
    online,
  };
}

export async function loadState(kernel: { request: (call: string, args: unknown) => Promise<unknown> }) {
  let devices = [] as Array<{ deviceId: string; label: string; online: boolean }>;
  try {
    const listing = await kernel.request("sys.device.list", { includeOffline: true });
    devices = asDeviceList(listing)
      .map(normalizeDevice)
      .filter((device) => device.deviceId.length > 0)
      .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  } catch {
    devices = [];
  }

  return { devices };
}

export async function execCommand(
  kernel: { request: (call: string, args: unknown) => Promise<unknown> },
  rawArgs: unknown,
) {
  const args = asRecord(rawArgs) ?? {};
  const command = String(args.command ?? "").trim();
  if (!command) {
    throw new Error("Command is required.");
  }

  const target = normalizeTarget(args.target);
  const requestArgs: Record<string, unknown> = { command };
  if (target !== "gsv") {
    requestArgs.target = target;
  }

  const workdir = String(args.workdir ?? "").trim();
  if (workdir) {
    requestArgs.workdir = workdir;
  }

  const timeout = parseOptionalPositiveInt(args.timeoutMs ?? args.timeout);
  if (timeout !== null) {
    requestArgs.timeout = timeout;
  }

  const background = args.background === true;
  if (background) {
    requestArgs.background = true;
    const yieldMs = parseOptionalPositiveInt(args.yieldMs);
    if (yieldMs !== null) {
      requestArgs.yieldMs = yieldMs;
    }
  }

  const startedAt = Date.now();
  const payload = await kernel.request("shell.exec", requestArgs);
  return {
    entry: normalizeTranscriptEntry(payload, startedAt, target, command),
  };
}
