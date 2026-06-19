import { dirname, normalizePath } from "../shared/paths";
import {
  bytesToArrayBuffer,
  getPersistedEntry,
  openFsDatabase,
  putPersistedEntry,
} from "../target/fs-persistence";
import {
  OFFSCREEN_MEDIA_RECORDER_TARGET,
  type MediaRecordingStatus,
  type MediaRecordingStopReason,
  type OffscreenMediaMessage,
  type OffscreenMediaResponse,
  type OffscreenMediaStartMessage,
  type OffscreenMediaStatusMessage,
  type OffscreenMediaStopMessage,
} from "../target/media-recorder-protocol";

type TimerHandle = ReturnType<typeof setTimeout>;

type RecordingState = {
  id: string;
  tabId: number;
  path: string;
  requestedPath: string;
  destination?: MediaRecordingStatus["destination"];
  startedAt: string;
  maxBytes: number;
  maxDurationMs: number;
  monitor: boolean;
  mimeType: string;
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  size: number;
  stopReason: MediaRecordingStopReason;
  timer: TimerHandle | null;
  audioContext: AudioContext | null;
  monitorSource: MediaStreamAudioSourceNode | null;
  finalizing: boolean;
  completion: Promise<MediaRecordingStatus>;
  resolveCompletion: (status: MediaRecordingStatus) => void;
  rejectCompletion: (error: Error) => void;
};

const activeRecordings = new Map<string, RecordingState>();
const completedRecordings = new Map<string, MediaRecordingStatus>();
const DEFAULT_DIRECTORIES = new Set([
  "/",
  "/home",
  "/home/browser",
  "/home/browser/recordings",
  "/home/browser/screenshots",
  "/tmp",
]);
const MAX_COMPLETED_RECORDINGS = 50;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isOffscreenMediaMessage(message)) {
    return false;
  }

  void handleMessage(message)
    .then((value) => {
      sendResponse({ ok: true, value } satisfies OffscreenMediaResponse<unknown>);
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies OffscreenMediaResponse<unknown>);
    });
  return true;
});

async function handleMessage(message: OffscreenMediaMessage): Promise<unknown> {
  switch (message.type) {
    case "start":
      return await startRecording(message);
    case "stop":
      return await stopRecording(message);
    case "status":
      return recordingStatus(message);
  }
}

async function startRecording(message: OffscreenMediaStartMessage): Promise<MediaRecordingStatus> {
  const existingForTab = Array.from(activeRecordings.values()).find((state) => state.tabId === message.tabId);
  if (existingForTab) {
    throw new Error(`tab audio recording already active for tab ${message.tabId}: ${existingForTab.id}`);
  }
  const normalizedPath = normalizePath(message.path);
  await assertWritableRecordingPath(normalizedPath);

  const stream = await navigator.mediaDevices.getUserMedia(tabAudioConstraints(message.streamId));
  let state: RecordingState | null = null;
  try {
    const mimeType = preferredAudioMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const completion = promiseWithResolvers<MediaRecordingStatus>();
    state = {
      id: message.recordingId,
      tabId: message.tabId,
      path: normalizedPath,
      requestedPath: message.requestedPath,
      destination: message.destination,
      startedAt: message.startedAt,
      maxBytes: message.maxBytes,
      maxDurationMs: message.maxDurationMs,
      monitor: message.monitor,
      mimeType: recorder.mimeType || mimeType || "audio/webm",
      stream,
      recorder,
      chunks: [],
      size: 0,
      stopReason: "stopped",
      timer: null,
      audioContext: null,
      monitorSource: null,
      finalizing: false,
      completion: completion.promise,
      resolveCompletion: completion.resolve,
      rejectCompletion: completion.reject,
    };

    configureMonitoring(state);
    configureRecorder(state);
    activeRecordings.set(state.id, state);
    recorder.start(1000);
    const activeState = state;
    activeState.timer = setTimeout(() => stopState(activeState, "max-duration"), activeState.maxDurationMs);
    return activeStatus(activeState);
  } catch (error) {
    if (state) {
      activeRecordings.delete(state.id);
      stopMediaStream(state);
    } else {
      stopStream(stream);
    }
    throw error;
  }
}

async function stopRecording(message: OffscreenMediaStopMessage): Promise<MediaRecordingStatus[]> {
  if (message.recordingId) {
    const state = activeRecordings.get(message.recordingId);
    if (!state) {
      const completed = completedRecordings.get(message.recordingId);
      if (completed) {
        return [completed];
      }
      throw new Error(`recording not found: ${message.recordingId}`);
    }
    stopState(state, "stopped");
    return [await state.completion];
  }

  const states = Array.from(activeRecordings.values());
  for (const state of states) {
    stopState(state, "stopped");
  }
  return await Promise.all(states.map((state) => state.completion));
}

function recordingStatus(message: OffscreenMediaStatusMessage): MediaRecordingStatus[] {
  if (message.recordingId) {
    const state = activeRecordings.get(message.recordingId);
    if (state) {
      return [activeStatus(state)];
    }
    const completed = completedRecordings.get(message.recordingId);
    return completed ? [completed] : [];
  }
  return [
    ...Array.from(activeRecordings.values()).map(activeStatus),
    ...Array.from(completedRecordings.values()),
  ].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

function configureMonitoring(state: RecordingState): void {
  if (!state.monitor) {
    return;
  }
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(state.stream);
  source.connect(audioContext.destination);
  state.audioContext = audioContext;
  state.monitorSource = source;
  void audioContext.resume().catch(() => undefined);
}

function configureRecorder(state: RecordingState): void {
  for (const track of state.stream.getTracks()) {
    track.addEventListener("ended", () => stopState(state, "stream-ended"), { once: true });
  }

  state.recorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) {
      return;
    }
    state.chunks.push(event.data);
    state.size += event.data.size;
    if (state.size >= state.maxBytes) {
      stopState(state, "max-bytes");
    }
  };
  state.recorder.onerror = () => stopState(state, "recorder-error");
  state.recorder.onstop = () => {
    void finalizeRecording(state);
  };
}

function stopState(state: RecordingState, reason: MediaRecordingStopReason): void {
  if (state.finalizing) {
    return;
  }
  if (state.stopReason === "stopped" || reason !== "stopped") {
    state.stopReason = reason;
  }
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.recorder.state !== "inactive") {
    state.recorder.stop();
    return;
  }
  void finalizeRecording(state);
}

async function finalizeRecording(state: RecordingState): Promise<void> {
  if (state.finalizing) {
    return;
  }
  state.finalizing = true;
  activeRecordings.delete(state.id);
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  try {
    stopMediaStream(state);
    const stoppedAt = new Date().toISOString();
    const blob = new Blob(state.chunks, { type: state.mimeType });
    await persistRecordingBlob(state.path, blob);
    const status: MediaRecordingStatus = {
      id: state.id,
      tabId: state.tabId,
      active: false,
      path: state.path,
      localPath: state.path,
      requestedPath: state.requestedPath,
      destination: state.destination,
      startedAt: state.startedAt,
      stoppedAt,
      durationMs: Math.max(0, Date.parse(stoppedAt) - Date.parse(state.startedAt)),
      size: blob.size,
      mimeType: state.mimeType,
      stopReason: state.stopReason,
      truncated: state.stopReason === "max-bytes",
    };
    rememberCompleted(status);
    state.resolveCompletion(status);
  } catch (error) {
    state.rejectCompletion(error instanceof Error ? error : new Error(String(error)));
  }
}

function stopMediaStream(state: RecordingState): void {
  state.monitorSource?.disconnect();
  void state.audioContext?.close().catch(() => undefined);
  stopStream(state.stream);
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

async function persistRecordingBlob(path: string, blob: Blob): Promise<void> {
  const normalized = normalizePath(path);
  const db = await openFsDatabase();
  try {
    await assertPersistedPathIsNotDirectory(db, normalized);
    await persistDirectoryChain(db, dirname(normalized));
    const content = bytesToArrayBuffer(new Uint8Array(await blob.arrayBuffer()));
    await putPersistedEntry(db, {
      path: normalized,
      kind: "file",
      content,
      updatedAt: Date.now(),
    });
  } finally {
    db.close();
  }
}

async function assertWritableRecordingPath(path: string): Promise<void> {
  if (!isWritablePath(path)) {
    throw new Error(`Read-only path: ${path}`);
  }
  const db = await openFsDatabase();
  try {
    await assertPersistedPathIsNotDirectory(db, path);
  } finally {
    db.close();
  }
}

async function assertPersistedPathIsNotDirectory(db: IDBDatabase, path: string): Promise<void> {
  if (DEFAULT_DIRECTORIES.has(path)) {
    throw new Error(`Is a directory: ${path}`);
  }
  const entry = await getPersistedEntry(db, path);
  if (entry?.kind === "directory") {
    throw new Error(`Is a directory: ${path}`);
  }
}

function isWritablePath(path: string): boolean {
  return path === "/tmp"
    || path.startsWith("/tmp/")
    || path === "/home/browser"
    || path.startsWith("/home/browser/");
}

async function persistDirectoryChain(db: IDBDatabase, path: string): Promise<void> {
  const parts = normalizePath(path).split("/").filter(Boolean);
  let current = "";
  await putPersistedEntry(db, { path: "/", kind: "directory", updatedAt: Date.now() });
  for (const part of parts) {
    current = `${current}/${part}`;
    await putPersistedEntry(db, { path: current, kind: "directory", updatedAt: Date.now() });
  }
}

function rememberCompleted(status: MediaRecordingStatus): void {
  completedRecordings.set(status.id, status);
  while (completedRecordings.size > MAX_COMPLETED_RECORDINGS) {
    const oldest = completedRecordings.keys().next().value;
    if (!oldest) {
      return;
    }
    completedRecordings.delete(oldest);
  }
}

function activeStatus(state: RecordingState): MediaRecordingStatus {
  return {
    id: state.id,
    tabId: state.tabId,
    active: true,
    path: state.path,
    localPath: state.path,
    requestedPath: state.requestedPath,
    destination: state.destination,
    startedAt: state.startedAt,
    durationMs: Math.max(0, Date.now() - Date.parse(state.startedAt)),
    size: state.size,
    mimeType: state.mimeType,
  };
}

function tabAudioConstraints(streamId: string): MediaStreamConstraints {
  return {
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    } as unknown as MediaTrackConstraints,
    video: false,
  };
}

function preferredAudioMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function isOffscreenMediaMessage(value: unknown): value is OffscreenMediaMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.target === OFFSCREEN_MEDIA_RECORDER_TARGET
    && (record.type === "start" || record.type === "stop" || record.type === "status");
}

function promiseWithResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
