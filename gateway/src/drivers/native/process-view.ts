import type { ProcessViewCall } from "../../fs/refs";
import type { RequestFrame } from "../../protocol/frames";
import { sendFrameToProcess } from "../../shared/utils";
import type { ArgsOf, ResultOf } from "../../syscalls";

export async function requestProcessView<S extends ProcessViewCall>(
  pid: string,
  call: S,
  args: ArgsOf<S>,
): Promise<ResultOf<S>> {
  const frame = {
    type: "req",
    id: crypto.randomUUID(),
    call,
    args,
  } as RequestFrame;
  const response = await sendFrameToProcess(pid, frame);
  if (!response || response.type !== "res") {
    throw new Error(`${call} did not return a response`);
  }
  if (!response.ok) {
    throw new Error(response.error.message);
  }
  return response.data as ResultOf<S>;
}
