/**
 * Native `gsv` target provider.
 *
 * This module owns the target-routable filesystem, shell, and network
 * environment implemented inside the Gateway. Kernel control-plane syscalls
 * remain in the Kernel dispatcher.
 */

import type { KernelContext } from "../../kernel/context";
import { handleNetFetch } from "../../kernel/net";
import { GSV_TARGET_ID } from "../../kernel/targets";
import type { RequestFrame, ResponseFrame } from "../../protocol/frames";
import {
  handleFsCopy,
  handleFsDelete,
  handleFsEdit,
  handleFsRead,
  handleFsSearch,
  handleFsTransferReceive,
  handleFsTransferSend,
  handleFsTransferStat,
  handleFsWrite,
} from "./fs";
import { handleShellExec } from "./shell";
import type { NativeShellCommandOptions } from "./shell/commands";

export async function dispatchGsvTarget(
  frame: RequestFrame,
  ctx: KernelContext,
  options: NativeShellCommandOptions,
): Promise<ResponseFrame> {
  let data: unknown;

  switch (frame.call) {
    case "fs.read":
      return {
        type: "res",
        id: frame.id,
        ok: true,
        ...await handleFsRead(frame.args, ctx),
      };
    case "fs.write":
      data = await handleFsWrite(frame.args, ctx);
      break;
    case "fs.edit":
      data = await handleFsEdit(frame.args, ctx);
      break;
    case "fs.delete":
      data = await handleFsDelete(frame.args, ctx);
      break;
    case "fs.search":
      data = await handleFsSearch(frame.args, ctx);
      break;
    case "fs.copy":
      data = await handleFsCopy(frame.args, ctx, options.fsTransport);
      break;
    case "fs.transfer.stat":
      data = await handleFsTransferStat(frame.args, ctx);
      break;
    case "fs.transfer.send":
      return await handleFsTransferSend(frame.args, ctx, frame.id);
    case "fs.transfer.receive":
      data = await handleFsTransferReceive(frame.args, ctx, frame.body);
      break;
    case "shell.exec":
      data = await handleShellExec(frame.args, ctx, options);
      break;
    case "net.fetch":
      return {
        type: "res",
        id: frame.id,
        ok: true,
        ...await handleNetFetch(frame.args, ctx, frame.body),
      };
    default:
      throw new Error(`The ${GSV_TARGET_ID} target does not implement ${frame.call}`);
  }

  // SAFETY: each switch branch assigns the result declared for its exact
  // target-routable syscall before the response envelope is constructed.
  return { type: "res", id: frame.id, ok: true, data } as ResponseFrame;
}
