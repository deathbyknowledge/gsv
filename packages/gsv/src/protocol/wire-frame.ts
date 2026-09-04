import type { BinaryFrameDescriptor } from "./binary-frame";
import type {
  ResponseErrEnvelope,
  ResponseOkEnvelope,
  SignalEnvelope,
  TypedRequest,
  TypedResponse,
  TypedResponseOk,
} from "./frame";
import type { SyscallDomains, SyscallName } from "./syscalls/map";

export type WireRequestFrame<S extends SyscallName = SyscallName> =
  TypedRequest<SyscallDomains, S, BinaryFrameDescriptor>;

export type WireResponseOkFrame<S extends SyscallName = SyscallName> =
  TypedResponseOk<SyscallDomains, S, BinaryFrameDescriptor>;

export type WireResponseFrame<S extends SyscallName = SyscallName> =
  TypedResponse<SyscallDomains, S, BinaryFrameDescriptor>;

export type WireResponseEnvelope =
  | ResponseOkEnvelope<BinaryFrameDescriptor>
  | ResponseErrEnvelope;

export type WireRoutedResponse = {
  [S in SyscallName]: {
    call: S;
    frame: WireResponseFrame<S>;
  };
}[SyscallName];

export type WireSignalFrame = SignalEnvelope;

export type WireFrame = WireRequestFrame | WireResponseEnvelope | WireSignalFrame;

export type WireValidationRoots = {
  frame: WireFrame;
  routedResponse: WireRoutedResponse;
};
