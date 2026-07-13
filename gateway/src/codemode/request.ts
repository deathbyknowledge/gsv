import { bodyFromBytes } from "@humansandmachines/gsv/protocol";
import type { FrameBody } from "../protocol/frames";
import type { SyscallName } from "../syscalls";
import { decodeBase64Bytes } from "../shared/base64";

export function createCodeModeRequest(
  call: SyscallName,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; body?: FrameBody } {
  if (call !== "net.fetch" || typeof args.bodyBase64 !== "string") {
    return { args };
  }

  const encoded = args.bodyBase64;
  const next = { ...args };
  delete next.bodyBase64;
  return encoded
    ? { args: next, body: bodyFromBytes(decodeBase64Bytes(encoded)) }
    : { args: next };
}
