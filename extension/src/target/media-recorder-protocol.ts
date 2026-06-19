import type { TargetCopyEndpoint } from "./types";

export const OFFSCREEN_MEDIA_RECORDER_TARGET = "gsv-media-recorder-offscreen";

export type MediaRecordingMode = "audio" | "video";

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
  mode: MediaRecordingMode;
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
  mode: MediaRecordingMode;
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

export type OffscreenMediaCopyCompleteMessage = {
  target: typeof OFFSCREEN_MEDIA_RECORDER_TARGET;
  type: "copy-complete";
  recordingId: string;
  copy?: unknown;
};

export type OffscreenMediaMessage =
  | OffscreenMediaStartMessage
  | OffscreenMediaStopMessage
  | OffscreenMediaStatusMessage
  | OffscreenMediaCopyCompleteMessage;

export type OffscreenMediaResponse<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };
