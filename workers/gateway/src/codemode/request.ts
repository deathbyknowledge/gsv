import {
  bodyFromBytes,
  type JsonObject,
} from "@humansandmachines/gsv/protocol";
import * as z from "zod/mini";
import type { SyscallName } from "../syscalls";
import { decodeBase64Bytes } from "../shared/base64";

export function createCodeModeRequest(
  call: SyscallName,
  args: JsonObject,
) {
  if (call !== "net.fetch") {
    return { args };
  }

  const encoded = z.string().safeParse(args.bodyBase64);
  if (!encoded.success) return { args };

  const next = { ...args };
  delete next.bodyBase64;
  return encoded.data
    ? { args: next, body: bodyFromBytes(decodeBase64Bytes(encoded.data)) }
    : { args: next };
}
