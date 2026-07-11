import type { ArgsOf, ResultOf, SyscallName } from "../syscalls";

export type ErrorShape = {
  code: number;
  message: string;
  details?: unknown;
  retryable?: boolean;
};

export type FrameBody = {
  stream: ReadableStream<Uint8Array>;
  length?: number;
};

export type RequestFrame<S extends SyscallName = SyscallName> = {
  [K in S]: {
    type: "req";
    id: string;
    call: K;
    args: ArgsOf<K>;
    runId?: string;
    body?: FrameBody;
  };
}[S];

export type ResponseOkFrame<S extends SyscallName = SyscallName> = {
  type: "res";
  id: string;
  ok: true;
  data?: ResultOf<S>;
  body?: FrameBody;
};

export type ResponseErrFrame = {
  type: "res";
  id: string;
  ok: false;
  error: ErrorShape;
};

export type ResponseFrame<S extends SyscallName = SyscallName> =
  | ResponseOkFrame<S>
  | ResponseErrFrame;

export type SignalFrame<Payload = unknown> = {
  type: "sig";
  signal: string;
  payload?: Payload;
  seq?: number;
};

export type Frame = RequestFrame | ResponseFrame | SignalFrame;
