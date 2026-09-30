import { createContext, type ComponentChildren } from "preact";
import { useContext, useLayoutEffect, useRef } from "preact/hooks";

export type ControlCommand =
  | { type: "status" | "new" | "microphoneList" | "microphoneDefault" }
  | { type: "use"; processId: string }
  | { type: "microphoneUse"; name: string };
export type ControlError = "busy" | "unavailable" | "processNotFound" | "permissionDenied" | "conflict";
export type MicrophoneStatus = {
  devices: { name: string; isDefault: boolean }[];
  selected: { type: "systemDefault" } | { type: "device"; name: string };
  environmentOverride: null;
};
export type ControlResponse =
  | { type: "status"; status: { gateway: "connected" | "connecting" | "disconnected"; window: "visible"; selectedProcess: string | null } }
  | { type: "created" | "selected"; processId: string }
  | { type: "microphonesListed" | "microphoneSelected" | "defaultMicrophoneSelected"; status: MicrophoneStatus };
export type ControlRequest = {
  command: ControlCommand;
  signal: AbortSignal;
  /** Recheck host authority immediately before a gateway request or UI mutation. */
  checkpoint(): Promise<void>;
};
export type ControlHandler = (request: ControlRequest) => Promise<ControlResponse>;
export type ClientControl = {
  register(commands: readonly ControlCommand["type"][], handler: ControlHandler): () => void;
};

const Context = createContext<ClientControl | null>(null);
export function ClientControlProvider({ control, children }: { control: ClientControl; children: ComponentChildren }) {
  return <Context.Provider value={control}>{children}</Context.Provider>;
}

export function useClientControl(commands: readonly ControlCommand["type"][], handler: ControlHandler, enabled = true) {
  const control = useContext(Context);
  const latest = useRef(handler);
  latest.current = handler;
  const key = commands.join(",");
  useLayoutEffect(() => {
    if (control && enabled) return control.register(commands, (request) => latest.current(request));
  }, [control, key, enabled]);
}

export class ClientControlError extends Error {
  constructor(readonly code: ControlError) { super(code); }
}
