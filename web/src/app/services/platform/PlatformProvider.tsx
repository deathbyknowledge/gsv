import { createContext, type ComponentChildren } from "preact";
import { useContext } from "preact/hooks";

export type SegmentAction = "send";
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
export type NativeSnapshot = {
  lease: string;
  voice: NativeVoice | null;
  devices: { id: string; name: string; is_default: boolean }[];
  devices_loading: boolean;
  devices_revision: number;
  notice: string | null;
  events: NativeEvent[];
};
export type NativeCommand =
  | { kind: "start"; device_id: string | null }
  | { kind: "stop"; request_id: number }
  | { kind: "finish"; request_id: number }
  | { kind: "cancel" | "devices" | "detach" }
  | { kind: "segment"; request_id: number; segment_id: number; action: SegmentAction };

export type NativeUpdate = { revision: number; sent_at_ms: number; snapshot: NativeSnapshot };
export type NativeSubscription = { initial: Promise<NativeSnapshot>; dispose(): void };
export type NativeInput = {
  subscribe(receive: (update: NativeUpdate) => void): NativeSubscription;
  acknowledge(lease: string, revision: number, ack: number): Promise<void>;
  command(lease: string, command: NativeCommand): Promise<void>;
};

const PlatformContext = createContext<NativeInput | null>(null);
export function NativeInputProvider({ input, children }: { input: NativeInput; children: ComponentChildren }) {
  return <PlatformContext.Provider value={input}>{children}</PlatformContext.Provider>;
}
export const useNativeInput = () => useContext(PlatformContext);
