import type { TargetCopyEndpoint } from "./types";

export const OFFSCREEN_MEDIA_RECORDER_TARGET = "gsv-media-recorder-offscreen";

export type MediaRecordingStopReason =
  | "stopped"
  | "max-duration"
  | "max-bytes"
  | "stream-ended"
  | "recorder-error";

export type MediaRecordingStatus = {
  id: string;
  tabId: number;
  active: boolean;
  path: string;
  localPath: string;
  requestedPath: string;
  destination?: TargetCopyEndpoint;
  startedAt: string;
  stoppedAt?: string;
  durationMs?: number;
  size?: number;
  mimeType?: string;
  stopReason?: MediaRecordingStopReason;
  truncated?: boolean;
  copy?: unknown;
};

export type OffscreenMediaStartMessage = {
  target: typeof OFFSCREEN_MEDIA_RECORDER_TARGET;
  type: "start";
  recordingId: string;
  tabId: number;
  streamId: string;
  path: string;
  requestedPath: string;
  destination?: TargetCopyEndpoint;
  maxBytes: number;
  maxDurationMs: number;
  monitor: boolean;
  startedAt: string;
};

export type OffscreenMediaStopMessage = {
  target: typeof OFFSCREEN_MEDIA_RECORDER_TARGET;
  type: "stop";
  recordingId?: string;
};

export type OffscreenMediaStatusMessage = {
  target: typeof OFFSCREEN_MEDIA_RECORDER_TARGET;
  type: "status";
  recordingId?: string;
};

export type OffscreenMediaMessage =
  | OffscreenMediaStartMessage
  | OffscreenMediaStopMessage
  | OffscreenMediaStatusMessage;

export type OffscreenMediaResponse<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };
