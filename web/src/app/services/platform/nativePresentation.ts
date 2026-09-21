import type { NativeSnapshot } from "./PlatformProvider";

/** Transport acknowledgements and dictated text do not invalidate the input controls. */
export function sameNativePresentation(a: NativeSnapshot | null, b: NativeSnapshot): boolean {
  if (!a || a.lease !== b.lease || a.gestures_enabled !== b.gestures_enabled
    || a.gesture_status !== b.gesture_status || a.gesture_action !== b.gesture_action || a.notice !== b.notice
    || a.gesture_action_sequence !== b.gesture_action_sequence
    || a.gesture_needs_reset !== b.gesture_needs_reset || a.gesture_reset_after_action !== b.gesture_reset_after_action
    || a.devices_loading !== b.devices_loading
    || Math.sign(a.scroll_velocity) !== Math.sign(b.scroll_velocity)) return false;
  if (a.gesture_context.mode !== b.gesture_context.mode
    || (a.gesture_context.mode === "active" && b.gesture_context.mode === "active"
      && (a.gesture_context.voice_request_id !== b.gesture_context.voice_request_id || a.gesture_context.muted !== b.gesture_context.muted))) return false;
  if (a.gesture_progress?.candidate !== b.gesture_progress?.candidate
    || a.gesture_progress?.progress_permille !== b.gesture_progress?.progress_permille) return false;
  if (a.gesture_practice?.lesson_id !== b.gesture_practice?.lesson_id
    || a.gesture_practice?.feedback_sequence !== b.gesture_practice?.feedback_sequence
    || Boolean(a.gesture_practice?.feedback) !== Boolean(b.gesture_practice?.feedback)) return false;
  if (Boolean(a.voice) !== Boolean(b.voice)) return false;
  if (a.voice && b.voice && (a.voice.request_id !== b.voice.request_id || a.voice.phase !== b.voice.phase
    || a.voice.progress !== b.voice.progress || a.voice.muted !== b.voice.muted
    || a.voice.pending !== b.voice.pending)) return false;
  return a.devices.length === b.devices.length && a.devices.every((device, index) => {
    const next = b.devices[index];
    return device.id === next.id && device.name === next.name && device.is_default === next.is_default;
  });
}
