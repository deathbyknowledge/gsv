import { ArgsOf, SyscallDomain, SyscallName } from "../syscalls";
import type { ConnectArgs } from "../syscalls/system";

// base error shape used in responses
export type ErrorShape = {
  code: number;
  message: string;
  details?: unknown;
  retryable?: boolean;
};

// generic request frame with method and params
export type RequestFrame<S extends SyscallName = SyscallName> = {
  [K in S]: { type: "req"; id: string; call: K; args: ArgsOf<K> };
}[S];

// successful response frame with result
export type ResponseOkFrame<Payload = unknown> = {
  type: "res";
  id: string;
  ok: true;
  data?: Payload;
};

// error response frame with error details
export type ResponseErrFrame = {
  type: "res";
  id: string;
  ok: false;
  error: ErrorShape;
};

// union response frames
export type ResponseFrame<Payload = unknown> =
  | ResponseOkFrame<Payload>
  | ResponseErrFrame;

// generic event frame with event name and payload
export type SignalFrame<Payload = unknown> = {
  type: "sig";
  signal: string;
  payload?: Payload;
  seq?: number;
};

// union frame type
export type Frame = RequestFrame | ResponseFrame | SignalFrame;
