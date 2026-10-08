import type { BrowserCommand, CommandContext, CommandResult } from "../types";
import { commandError, commandJson, commandOk } from "../types";
import { hasHelpFlag, parseInteger, splitOption } from "./args";
import {
  DEFAULT_AUDIO_RECORDING_MAX_BYTES,
  DEFAULT_RECORDING_MAX_DURATION_MS,
  DEFAULT_VIDEO_RECORDING_MAX_BYTES,
  MAX_RECORDING_BYTES,
  MAX_RECORDING_DURATION_MS,
  mediaRecordingStatus,
  startMediaRecording,
  stopMediaRecording,
} from "../media-recorder";
import type { MediaRecordingMode } from "../media-recorder-protocol";

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

type StartOptions = {
  tabId?: number;
  path?: string;
  mode: MediaRecordingMode;
  maxDurationMs: number;
  maxBytes: number;
  monitor: boolean;
};

const MEDIA_USAGE = [
  "Usage: media record <start|stop|status|list> [args]",
  "       media record start [--tab <tabId>] [--path path] [--mode audio|video] [--video] [--max-duration 10m] [--max-bytes bytes] [--monitor on|off]",
  "       media record stop [recordingId]",
  "       media record status [recordingId]",
  "       media record list",
].join("\n");

const MEDIA_RECORD_START_USAGE = "Usage: media record start [--tab <tabId>] [--path path] [--mode audio|video] [--video] [--max-duration 10m] [--max-bytes bytes] [--monitor on|off]";
const MEDIA_RECORD_STOP_USAGE = "Usage: media record stop [recordingId]";
const MEDIA_RECORD_STATUS_USAGE = "Usage: media record status [recordingId]";
const MEDIA_RECORD_LIST_USAGE = "Usage: media record list";

export const mediaCommand: BrowserCommand = {
  name: "media",
  summary: "Record tab audio or video to the browser target filesystem.",
  async run(args: string[], ctx: CommandContext): Promise<CommandResult> {
    return await runMediaCommand(args, ctx);
  },
};

export default mediaCommand;

async function runMediaCommand(args: string[], ctx: CommandContext): Promise<CommandResult> {
  if (hasHelpFlag(args)) {
    return commandOk(`${usageFor(args)}\n`);
  }

  const noun = args[0] ?? "record";
  if (noun !== "record") {
    return commandError(`Unknown media command: ${noun}\n${MEDIA_USAGE}`);
  }

  const subcommand = args[1] ?? "status";
  try {
    switch (subcommand) {
      case "start":
        return await runStart(args.slice(2), ctx);
      case "stop":
        return await runStop(args.slice(2), ctx);
      case "status":
        return await runStatus(args.slice(2));
      case "list":
        return await runList(args.slice(2));
      default:
        return commandError(`Unknown media record command: ${subcommand}\n${MEDIA_USAGE}`);
    }
  } catch (error) {
    return commandError(`media record ${subcommand}: ${errorMessage(error)}`);
  }
}

async function runStart(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const parsed = parseStartOptions(args);
  if (!parsed.ok) {
    return commandError(parsed.error);
  }
  const status = await startMediaRecording({
    ...parsed.value,
    cwd: ctx.cwd,
    fs: ctx.fs,
    currentTargetId: ctx.currentTargetId,
  });
  return commandJson(status);
}

async function runStop(args: string[], ctx: CommandContext): Promise<CommandResult> {
  if (args.length > 1 || args.some((arg) => arg.startsWith("-"))) {
    return commandError(MEDIA_RECORD_STOP_USAGE);
  }
  const stopped = await stopMediaRecording(args[0], ctx);
  return commandJson({ stopped, count: stopped.length });
}

async function runStatus(args: string[]): Promise<CommandResult> {
  if (args.length > 1 || args.some((arg) => arg.startsWith("-"))) {
    return commandError(MEDIA_RECORD_STATUS_USAGE);
  }
  const recordings = await mediaRecordingStatus(args[0]);
  return commandJson({
    recordings,
    activeCount: recordings.filter((recording) => recording.active).length,
  });
}

async function runList(args: string[]): Promise<CommandResult> {
  if (args.length > 0) {
    return commandError(MEDIA_RECORD_LIST_USAGE);
  }
  const recordings = await mediaRecordingStatus();
  return commandJson({
    recordings,
    activeCount: recordings.filter((recording) => recording.active).length,
  });
}

function parseStartOptions(args: string[]): Parsed<StartOptions> {
  const videoSplit = splitFlag(args, "--video");
  const modeSplit = splitOption(videoSplit.rest, "--mode");
  const mode = parseMode(modeSplit.value, videoSplit.found);
  if (!mode.ok) {
    return { ok: false, error: mode.error };
  }

  const tabSplit = splitOption(modeSplit.rest, "--tab");
  const pathSplit = splitOption(tabSplit.rest, "--path");
  const durationSplit = splitOption(pathSplit.rest, "--max-duration");
  const bytesSplit = splitOption(durationSplit.rest, "--max-bytes");
  const monitorSplit = splitOption(bytesSplit.rest, "--monitor");

  const tabId = parseOptionalPositiveInteger(tabSplit.value, "tabId", MEDIA_RECORD_START_USAGE);
  if (!tabId.ok) {
    return { ok: false, error: tabId.error };
  }
  const maxDurationMs = parseOptionalDuration(monitorSplit.rest, durationSplit.value);
  if (!maxDurationMs.ok) {
    return { ok: false, error: maxDurationMs.error };
  }
  const maxBytes = parseOptionalBytes(bytesSplit.value, mode.value);
  if (!maxBytes.ok) {
    return { ok: false, error: maxBytes.error };
  }
  const monitor = parseMonitor(monitorSplit.value);
  if (!monitor.ok) {
    return { ok: false, error: monitor.error };
  }
  if (monitorSplit.rest.length > 0) {
    return { ok: false, error: `${MEDIA_RECORD_START_USAGE}\nUnknown option: ${monitorSplit.rest[0]}` };
  }

  return {
    ok: true,
    value: {
      tabId: tabId.value ?? undefined,
      path: pathSplit.value ?? undefined,
      mode: mode.value,
      maxDurationMs: maxDurationMs.value,
      maxBytes: maxBytes.value,
      monitor: monitor.value,
    },
  };
}

function splitFlag(args: string[], name: string): { found: boolean; rest: string[] } {
  const rest: string[] = [];
  let found = false;
  for (const arg of args) {
    if (arg === name) {
      found = true;
      continue;
    }
    rest.push(arg);
  }
  return { found, rest };
}

function parseMode(value: string | null, videoFlag: boolean): Parsed<MediaRecordingMode> {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return { ok: true, value: videoFlag ? "video" : "audio" };
  }
  if (normalized !== "audio" && normalized !== "video") {
    return { ok: false, error: `${MEDIA_RECORD_START_USAGE}\nmode must be audio or video` };
  }
  if (videoFlag && normalized !== "video") {
    return { ok: false, error: `${MEDIA_RECORD_START_USAGE}\n--video cannot be combined with --mode audio` };
  }
  return { ok: true, value: normalized };
}

function parseOptionalPositiveInteger(
  value: string | null,
  label: string,
  usage: string,
): Parsed<number | null> {
  if (value === null) {
    return { ok: true, value: null };
  }
  const parsed = parseInteger(value);
  if (parsed === null || parsed <= 0) {
    return { ok: false, error: `${usage}\n${label} must be a positive integer` };
  }
  return { ok: true, value: parsed };
}

function parseOptionalDuration(rest: string[], value: string | null): Parsed<number> {
  if (rest.length > 0) {
    return { ok: false, error: `${MEDIA_RECORD_START_USAGE}\nUnknown option: ${rest[0]}` };
  }
  if (value === null) {
    return { ok: true, value: DEFAULT_RECORDING_MAX_DURATION_MS };
  }
  const parsed = parseDuration(value);
  if (parsed === null || parsed <= 0 || parsed > MAX_RECORDING_DURATION_MS) {
    return {
      ok: false,
      error: `${MEDIA_RECORD_START_USAGE}\nmax-duration must be from 1ms to ${formatDuration(MAX_RECORDING_DURATION_MS)}`,
    };
  }
  return { ok: true, value: parsed };
}

function parseOptionalBytes(value: string | null, mode: MediaRecordingMode): Parsed<number> {
  if (value === null) {
    return {
      ok: true,
      value: mode === "video" ? DEFAULT_VIDEO_RECORDING_MAX_BYTES : DEFAULT_AUDIO_RECORDING_MAX_BYTES,
    };
  }
  const parsed = parseBytes(value);
  if (parsed === null || parsed <= 0 || parsed > MAX_RECORDING_BYTES) {
    return {
      ok: false,
      error: `${MEDIA_RECORD_START_USAGE}\nmax-bytes must be from 1 byte to ${formatBytes(MAX_RECORDING_BYTES)}`,
    };
  }
  return { ok: true, value: parsed };
}

function parseMonitor(value: string | null): Parsed<boolean> {
  if (value === null || value === "") {
    return { ok: true, value: true };
  }
  const normalized = value.toLowerCase();
  if (["on", "true", "1", "yes"].includes(normalized)) {
    return { ok: true, value: true };
  }
  if (["off", "false", "0", "no"].includes(normalized)) {
    return { ok: true, value: false };
  }
  return {
    ok: false,
    error: `${MEDIA_RECORD_START_USAGE}\nmonitor must be on or off`,
  };
}

function parseDuration(value: string): number | null {
  const match = value.trim().match(/^(\d+)(ms|s|m|h)?$/i);
  if (!match) {
    return null;
  }
  const amount = parseInteger(match[1]);
  if (amount === null) {
    return null;
  }
  const unit = (match[2] ?? "ms").toLowerCase();
  const multiplier = unit === "h"
    ? 60 * 60 * 1000
    : unit === "m"
      ? 60 * 1000
      : unit === "s"
        ? 1000
        : 1;
  const result = amount * multiplier;
  return Number.isSafeInteger(result) ? result : null;
}

function parseBytes(value: string): number | null {
  const match = value.trim().match(/^(\d+)(b|kb|kib|mb|mib|gb|gib)?$/i);
  if (!match) {
    return null;
  }
  const amount = parseInteger(match[1]);
  if (amount === null) {
    return null;
  }
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier = unit === "gb" || unit === "gib"
    ? 1024 * 1024 * 1024
    : unit === "mb" || unit === "mib"
      ? 1024 * 1024
      : unit === "kb" || unit === "kib"
        ? 1024
        : 1;
  const result = amount * multiplier;
  return Number.isSafeInteger(result) ? result : null;
}

function usageFor(args: string[]): string {
  if (args[0] !== "record") {
    return MEDIA_USAGE;
  }
  switch (args[1]) {
    case "start":
      return MEDIA_RECORD_START_USAGE;
    case "stop":
      return MEDIA_RECORD_STOP_USAGE;
    case "status":
      return MEDIA_RECORD_STATUS_USAGE;
    case "list":
      return MEDIA_RECORD_LIST_USAGE;
    default:
      return MEDIA_USAGE;
  }
}

function formatDuration(ms: number): string {
  if (ms % (60 * 60 * 1000) === 0) {
    return `${ms / (60 * 60 * 1000)}h`;
  }
  if (ms % (60 * 1000) === 0) {
    return `${ms / (60 * 1000)}m`;
  }
  if (ms % 1000 === 0) {
    return `${ms / 1000}s`;
  }
  return `${ms}ms`;
}

function formatBytes(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) {
    return `${bytes / 1024 / 1024}MiB`;
  }
  if (bytes % 1024 === 0) {
    return `${bytes / 1024}KiB`;
  }
  return `${bytes}B`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
