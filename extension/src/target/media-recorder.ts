import { activeTab, getTab } from "../shared/chrome";
import { basename, normalizePath } from "../shared/paths";
import {
  OFFSCREEN_MEDIA_RECORDER_TARGET,
  type MediaRecordingStatus,
  type OffscreenMediaMessage,
  type OffscreenMediaResponse,
} from "./media-recorder-protocol";
import type { CommandContext, TargetCopyEndpoint, TargetFileSystem } from "./types";

export const DEFAULT_RECORDING_MAX_DURATION_MS = 10 * 60 * 1000;
export const MAX_RECORDING_DURATION_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_RECORDING_MAX_BYTES = 100 * 1024 * 1024;
export const MAX_RECORDING_BYTES = 512 * 1024 * 1024;

export type StartMediaRecordingOptions = {
  tabId?: number;
  path?: string;
  cwd: string;
  fs: TargetFileSystem;
  currentTargetId?: string;
  maxDurationMs: number;
  maxBytes: number;
  monitor: boolean;
};

export async function startMediaRecording(options: StartMediaRecordingOptions): Promise<MediaRecordingStatus> {
  const tabId = options.tabId ?? await activeTabId();
  const tab = await getTab(tabId);
  if (!tab) {
    throw new Error(`tab not found: ${tabId}`);
  }

  const startedAt = new Date().toISOString();
  const recordingId = newRecordingId();
  const output = resolveOutputPath({
    path: options.path,
    cwd: options.cwd,
    currentTargetId: options.currentTargetId,
    recordingId,
    tabId,
    now: Date.parse(startedAt),
  });
  await assertLocalWritableFile(options.fs, output.localPath);

  await ensureOffscreenDocument();
  const streamId = await getTabMediaStreamId(tabId);
  return await sendOffscreenMessage<MediaRecordingStatus>({
    target: OFFSCREEN_MEDIA_RECORDER_TARGET,
    type: "start",
    recordingId,
    tabId,
    streamId,
    path: output.localPath,
    requestedPath: output.requestedPath,
    destination: output.destination,
    maxBytes: options.maxBytes,
    maxDurationMs: options.maxDurationMs,
    monitor: options.monitor,
    startedAt,
  });
}

export async function stopMediaRecording(
  recordingId: string | undefined,
  ctx: CommandContext,
): Promise<MediaRecordingStatus[]> {
  if (!(await hasOffscreenDocument())) {
    return [];
  }
  const statuses = await sendOffscreenMessage<MediaRecordingStatus[]>({
    target: OFFSCREEN_MEDIA_RECORDER_TARGET,
    type: "stop",
    ...(recordingId ? { recordingId } : {}),
  });
  return await Promise.all(statuses.map((status) => copyCompletedRecording(status, ctx)));
}

export async function stopAllMediaRecordings(): Promise<MediaRecordingStatus[]> {
  if (!(await hasOffscreenDocument())) {
    return [];
  }
  return await sendOffscreenMessage<MediaRecordingStatus[]>({
    target: OFFSCREEN_MEDIA_RECORDER_TARGET,
    type: "stop",
  });
}

export async function mediaRecordingStatus(recordingId?: string): Promise<MediaRecordingStatus[]> {
  if (!(await hasOffscreenDocument())) {
    return [];
  }
  return await sendOffscreenMessage<MediaRecordingStatus[]>({
    target: OFFSCREEN_MEDIA_RECORDER_TARGET,
    type: "status",
    ...(recordingId ? { recordingId } : {}),
  });
}

type ResolvedOutputPath = {
  localPath: string;
  requestedPath: string;
  destination?: TargetCopyEndpoint;
};

function resolveOutputPath(options: {
  path?: string;
  cwd: string;
  currentTargetId?: string;
  recordingId: string;
  tabId: number;
  now: number;
}): ResolvedOutputPath {
  const defaultLocalPath = defaultRecordingPath(options.now, options.recordingId, options.tabId);
  const rawPath = options.path?.trim();
  if (!rawPath) {
    return {
      localPath: defaultLocalPath,
      requestedPath: defaultLocalPath,
    };
  }

  const endpoint = parseTargetEndpoint(rawPath);
  if (!endpoint) {
    const localPath = normalizePath(rawPath, options.cwd);
    return {
      localPath,
      requestedPath: localPath,
    };
  }

  if (options.currentTargetId && endpoint.target === options.currentTargetId) {
    const localPath = normalizePath(endpoint.path);
    return {
      localPath,
      requestedPath: rawPath,
    };
  }

  return {
    localPath: defaultLocalPath,
    requestedPath: rawPath,
    destination: endpoint,
  };
}

function parseTargetEndpoint(spec: string): TargetCopyEndpoint | null {
  const bracket = spec.match(/^\[([^\]]+)]:(.*)$/);
  if (bracket) {
    return {
      target: bracket[1] || "gsv",
      path: bracket[2] || ".",
    };
  }

  const match = spec.match(/^([A-Za-z0-9_.-]+):(.*)$/);
  if (!match) {
    return null;
  }
  return {
    target: match[1] || "gsv",
    path: match[2] || ".",
  };
}

function defaultRecordingPath(now: number, recordingId: string, tabId: number): string {
  const timestamp = new Date(now).toISOString().replace(/\D/g, "").slice(0, 14);
  const suffix = recordingId.slice(-6);
  return `/home/browser/recordings/${timestamp}-tab-${tabId}-${suffix}.webm`;
}

async function assertLocalWritableFile(fs: TargetFileSystem, path: string): Promise<void> {
  const normalized = normalizePath(path);
  if (!isWritablePath(normalized)) {
    throw new Error(`Read-only path: ${normalized}`);
  }
  let stat;
  try {
    stat = await fs.stat(normalized);
  } catch {
    return;
  }
  if (stat.isDirectory) {
    throw new Error(`Is a directory: ${normalized}`);
  }
}

function isWritablePath(path: string): boolean {
  return path === "/tmp"
    || path.startsWith("/tmp/")
    || path === "/home/browser"
    || path.startsWith("/home/browser/");
}

async function copyCompletedRecording(
  status: MediaRecordingStatus,
  ctx: CommandContext,
): Promise<MediaRecordingStatus> {
  if (status.active || !status.destination) {
    return status;
  }
  if (!ctx.currentTargetId) {
    return {
      ...status,
      copy: { ok: false, error: "current browser target id is unavailable" },
    };
  }
  if (!ctx.copyTargetFile) {
    return {
      ...status,
      copy: { ok: false, error: "gateway fs.copy is unavailable from this shell context" },
    };
  }

  const source = {
    target: ctx.currentTargetId,
    path: status.localPath,
  };
  try {
    const copy = await ctx.copyTargetFile(source, status.destination);
    if (copySucceeded(copy)) {
      await acknowledgeRecordingCopy(status.id, copy).catch(() => undefined);
    }
    return { ...status, copy };
  } catch (error) {
    return {
      ...status,
      copy: { ok: false, error: error instanceof Error ? error.message : String(error) },
    };
  }
}

async function acknowledgeRecordingCopy(recordingId: string, copy: unknown): Promise<void> {
  if (!(await hasOffscreenDocument())) {
    return;
  }
  await sendOffscreenMessage<MediaRecordingStatus | null>({
    target: OFFSCREEN_MEDIA_RECORDER_TARGET,
    type: "copy-complete",
    recordingId,
    copy,
  });
}

function copySucceeded(copy: unknown): boolean {
  const record = asRecord(copy);
  return record.ok !== false;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function activeTabId(): Promise<number> {
  const tab = await activeTab();
  if (!tab) {
    throw new Error("no active tab");
  }
  return tab.id;
}

async function getTabMediaStreamId(tabId: number): Promise<string> {
  try {
    return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error([
      `Unable to start tab audio capture for tab ${tabId}.`,
      "Chrome only grants tab capture after the extension has been invoked for the tab.",
      "Focus the tab, open the GSV extension UI, then retry.",
      message,
    ].filter(Boolean).join(" "));
  }
}

async function ensureOffscreenDocument(): Promise<void> {
  if (typeof chrome.offscreen?.hasDocument !== "function") {
    throw new Error("chrome.offscreen is unavailable in this browser");
  }
  if (await chrome.offscreen.hasDocument()) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: [
      chrome.offscreen.Reason.USER_MEDIA,
      chrome.offscreen.Reason.AUDIO_PLAYBACK,
      chrome.offscreen.Reason.BLOBS,
    ],
    justification: "Record tab audio requested by the GSV browser target.",
  });
}

async function hasOffscreenDocument(): Promise<boolean> {
  if (typeof chrome.offscreen?.hasDocument !== "function") {
    return false;
  }
  return await chrome.offscreen.hasDocument();
}

async function sendOffscreenMessage<T>(message: OffscreenMediaMessage): Promise<T> {
  const response = await chrome.runtime.sendMessage(message) as OffscreenMediaResponse<T> | undefined;
  if (!response) {
    throw new Error("No response from tab audio recorder");
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response.value;
}

function newRecordingId(): string {
  const random = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `rec_${Date.now().toString(36)}_${random}`;
}

export function displayRecordingPath(status: MediaRecordingStatus): string {
  if (!status.destination) {
    return status.localPath;
  }
  const destinationName = basename(status.destination.path);
  return `${status.destination.target}:${destinationName}`;
}
