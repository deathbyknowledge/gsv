import { z } from "zod";
import type { TerminalCommandInput, TerminalTarget, TerminalTranscriptEntry } from "./models";

type TerminalWireValue = string | number | boolean | null | TerminalWireValue[] | TerminalWireRecord;
type TerminalWireRecord = { [key: string]: TerminalWireValue };
const terminalWireSchema: z.ZodType<TerminalWireValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(terminalWireSchema),
  z.record(z.string(), terminalWireSchema),
]));

const terminalStringSchema = z.string().catch("");
const terminalNumberSchema = z.number().finite().nullable().catch(null);
const terminalBooleanSchema = z.boolean().nullable().catch(null);

const terminalTargetItemSchema = z.object({
  targetId: terminalStringSchema,
  id: terminalStringSchema,
  label: terminalStringSchema,
  online: terminalBooleanSchema,
  platform: terminalStringSchema,
  description: terminalStringSchema,
});

const terminalTargetsPayloadSchema = z.union([
  z.array(terminalWireSchema.pipe(terminalTargetItemSchema.catch({
    targetId: "",
    id: "",
    label: "",
    online: false,
    platform: "",
    description: "",
  }))),
  z.object({
    targets: z.array(terminalWireSchema.pipe(terminalTargetItemSchema.catch({
      targetId: "",
      id: "",
      label: "",
      online: false,
      platform: "",
      description: "",
    }))).catch([]),
  }),
]).catch([]);

const terminalTranscriptSchema = z.object({
  status: terminalStringSchema,
  error: terminalStringSchema,
  exitCode: terminalNumberSchema,
  stdout: terminalStringSchema,
  output: terminalStringSchema,
  stderr: terminalStringSchema,
  ok: terminalBooleanSchema,
  backgrounded: terminalBooleanSchema,
  background: terminalBooleanSchema,
  sessionId: terminalStringSchema,
  truncated: terminalBooleanSchema,
});

const optionalPositiveIntSchema = z.coerce.number().finite().positive().transform(Math.floor).nullable().catch(null);

function prettyJson<T>(value: T): string {
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

export function normalizeTerminalTargets<T>(payload: T): TerminalTarget[] {
  const parsed = terminalTargetsPayloadSchema.parse(payload);
  const rawDevices = Array.isArray(parsed) ? parsed : parsed.targets;
  const targets = rawDevices
    .map((device) => {
      const id = device.targetId || device.id;
      if (!id) {
        return null;
      }
      return {
        id,
        label: device.label || id,
    online: device.online ?? false,
        platform: device.platform,
        description: device.description,
      };
    })
    .filter((target): target is TerminalTarget => target !== null)
    .sort((left, right) => left.id.localeCompare(right.id));

  return targets;
}

export function parseOptionalPositiveInt<T>(value: T): number | null {
  return optionalPositiveIntSchema.parse(value);
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

export function normalizeTranscriptEntry<T>(
  payload: T,
  startedAt: number,
  input: ReturnType<typeof normalizeCommandInput>,
): TerminalTranscriptEntry {
  const completedAt = Date.now();
  const parsed = terminalTranscriptSchema.safeParse(payload);

  if (!parsed.success) {
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

  const record = parsed.data;
  const statusText = record.status.toLowerCase();
  const errorText = record.error || null;
  const exitCode = record.exitCode;
  const stdout = record.stdout || record.output;
  let stderr = record.stderr;
  const backgrounded = input.background || record.backgrounded === true || record.background === true;
  const failed = record.ok === false || statusText === "failed" || Boolean(errorText) || (exitCode !== null && exitCode !== 0);

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
    sessionId: record.sessionId || input.sessionId || null,
    truncated: record.truncated === true,
  };
}
