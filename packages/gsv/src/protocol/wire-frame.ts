import type { BinaryFrameDescriptor } from "./binary-frame";
import type { JsonValue } from "./json";
import type { ArgsOf, ResultOf, SyscallName } from "./syscalls/map";

export type WireError = {
  code: number;
  message: string;
  details?: JsonValue;
  retryable?: boolean;
};

export type WireRequestFrame<S extends SyscallName = SyscallName> = {
  [K in S]: {
    type: "req";
    id: string;
    call: K;
    args: ArgsOf<K>;
    runId?: string;
    body?: BinaryFrameDescriptor;
  };
}[S];

export type WireResponseOkFrame<S extends SyscallName = SyscallName> = {
  type: "res";
  id: string;
  ok: true;
  data?: ResultOf<S>;
  body?: BinaryFrameDescriptor;
};

export type WireResponseFrame<S extends SyscallName = SyscallName> =
  | WireResponseOkFrame<S>
  | {
    type: "res";
    id: string;
    ok: false;
    error: WireError;
  };

export type WireResponseEnvelope =
  | {
    type: "res";
    id: string;
    ok: true;
    data?: JsonValue;
    body?: BinaryFrameDescriptor;
  }
  | {
    type: "res";
    id: string;
    ok: false;
    error: WireError;
  };

export type WireRoutedResponse = {
  [S in SyscallName]: {
    call: S;
    frame: WireResponseFrame<S>;
  };
}[SyscallName];

export type WireSignalFrame = {
  type: "sig";
  signal: string;
  payload?: JsonValue;
  seq?: number;
};

export type WireFrame = WireRequestFrame | WireResponseEnvelope | WireSignalFrame;

export type WireValidationRoots = {
  frame: WireFrame;
  routedResponse: WireRoutedResponse;
};
