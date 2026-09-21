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
  mute_pending: boolean;
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
export type NativeSnapshot = {
  lease: string;
  voice: NativeVoice | null;
  gestures_enabled: boolean;
  armed: boolean;
  gesture_status: string;
  scroll_velocity: number;
  devices: { id: string; name: string; is_default: boolean }[];
  notice: string | null;
  events: NativeEvent[];
};
export type NativeCommand =
  | { kind: "start"; device_id: string | null }
  | { kind: "stop"; request_id: number }
  | { kind: "cancel" | "devices" | "detach" }
  | { kind: "segment"; request_id: number; segment_id: number; action: SegmentAction }
  | { kind: "mute"; request_id: number; muted: boolean }
  | { kind: "gestures"; enabled: boolean }
  | { kind: "arm"; armed: boolean };

export type NativeInput = {
  attach(): Promise<NativeSnapshot>;
  poll(lease: string, ack: number): Promise<NativeSnapshot>;
  command(lease: string, command: NativeCommand): Promise<void>;
};

const PlatformContext = createContext<NativeInput | null>(null);
export function NativeInputProvider({ input, children }: { input: NativeInput; children: ComponentChildren }) {
  return <PlatformContext.Provider value={input}>{children}</PlatformContext.Provider>;
}
export const useNativeInput = () => useContext(PlatformContext);
