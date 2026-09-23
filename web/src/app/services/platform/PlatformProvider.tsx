import { createContext, type ComponentChildren } from "preact";
import { useContext } from "preact/hooks";

export type SegmentAction = "send" | "delete" | "clear";
export type NativeVoice = {
  request_id: number;
  segment_id: number;
  revision: number;
  text: string;
  phase: string;
  progress: number | null;
  muted: boolean | null;
  pending: SegmentAction | null;
};
export type NativeEvent = {
  id: number;
  request_id: number;
  segment_id: number;
  kind: "started" | "segment" | "final";
  action: SegmentAction | null;
  text: string;
};
export type GestureCandidate = "arm" | "disarm" | "start_transcription" | "stop_transcription"
  | "send" | "delete_backward" | "clear_dictation" | "open_palm" | "mute" | "unmute";
export type PracticeTarget = "none" | "listen" | "dictate" | "send" | "delete" | "clear" | "pause" | "scroll" | "off";
export type PracticeGesture = "one" | "two" | "three" | "four" | "five" | "both_fists" | "scroll";
export type GesturePractice = {
  lesson_id: number;
  expected: PracticeTarget;
  feedback_sequence: number;
  feedback: { gesture: PracticeGesture; reason: "wrong_gesture" | "not_ready" } | null;
};
export type GestureContext =
  | { mode: "disarmed" | "disabled" | "standby" }
  | { mode: "active"; voice_request_id: number; muted: boolean }
  | { mode: "practice"; lesson_id: number };
export type NativeSnapshot = {
  lease: string;
  voice: NativeVoice | null;
  gestures_enabled: boolean;
  gesture_status: string;
  gesture_context: GestureContext;
  gesture_progress: { candidate: GestureCandidate; progress_permille: number } | null;
  gesture_action: GestureCandidate | null;
  gesture_action_sequence: number;
  gesture_needs_reset: boolean;
  gesture_reset_after_action: number;
  gesture_practice: GesturePractice | null;
  scroll_velocity: number;
  scroll_sequence: number;
  devices: { id: string; name: string; is_default: boolean }[];
  devices_loading: boolean;
  devices_revision: number;
  notice: string | null;
  events: NativeEvent[];
};
export type NativeCommand =
  | { kind: "start"; device_id: string | null }
  | { kind: "stop"; request_id: number }
  | { kind: "cancel" | "devices" | "detach" }
  | { kind: "segment"; request_id: number; segment_id: number; action: SegmentAction }
  | { kind: "gestures"; enabled: boolean }
  | { kind: "practice"; expected: PracticeTarget };

export type NativeUpdate = { revision: number; sent_at_ms: number; scroll_age_ms: number; snapshot: NativeSnapshot };
export type NativeSubscription = { initial: Promise<NativeSnapshot>; dispose(): void };
export type NativeInput = {
  subscribe(receive: (update: NativeUpdate) => void, practice?: boolean): NativeSubscription;
  acknowledge(lease: string, revision: number, ack: number): Promise<void>;
  command(lease: string, command: NativeCommand): Promise<void>;
};

const PlatformContext = createContext<NativeInput | null>(null);
export function NativeInputProvider({ input, children }: { input: NativeInput; children: ComponentChildren }) {
  return <PlatformContext.Provider value={input}>{children}</PlatformContext.Provider>;
}
export const useNativeInput = () => useContext(PlatformContext);
