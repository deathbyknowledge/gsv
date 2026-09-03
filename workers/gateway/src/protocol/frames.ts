import type {
  BinaryBody,
  FrameError,
  ResponseErrEnvelope,
  SignalEnvelope,
  SyscallDomains,
  TypedRequest,
  TypedResponse,
  TypedResponseOk,
} from "@humansandmachines/gsv/protocol";
import type { SyscallName } from "../syscalls";

export type { FrameError };

/** Gateway-side frames carry bodies as byte streams. */
export type FrameBody = BinaryBody;

export type RequestFrame<S extends SyscallName = SyscallName> =
  TypedRequest<SyscallDomains, S, BinaryBody>;

export type ResponseOkFrame<S extends SyscallName = SyscallName> =
  TypedResponseOk<SyscallDomains, S, BinaryBody>;

export type ResponseErrFrame = ResponseErrEnvelope;

export type ResponseFrame<S extends SyscallName = SyscallName> =
  TypedResponse<SyscallDomains, S, BinaryBody>;

export type SignalFrame<Payload = unknown> = SignalEnvelope<Payload>;

export type Frame = RequestFrame | ResponseFrame | SignalFrame;
