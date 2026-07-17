import { getAgentByName } from "agents";
import { Kernel } from "../kernel/do";
import { env } from "cloudflare:workers";
import { Process } from "../process/do";
import type { Frame, FrameBody, ResponseOkFrame } from "../protocol/frames";
import type {
  ProcessAdapterDeliverRequestFrame,
  ProcessAdapterDeliverResponseFrame,
  ProcessInboundFrame,
  ProcessRunAttachRequestFrame,
  ProcessRunAttachResponseFrame,
  ProcessScheduleDeliverRequestFrame,
  ProcessScheduleDeliverResponseFrame,
} from "../protocol/process-frames";
import type { NetFetchArgs } from "@humansandmachines/gsv/protocol";

export const isWebSocketRequest = (request: Request) =>
  request.method === "GET" && request.headers.get("upgrade") === "websocket";

// don't break the ✨illusion✨
type ProcessPtr = DurableObjectStub<Process>;
type KernelPtr = DurableObjectStub<Kernel>;

export type RequestProcessNetFetchOptions = {
  ttlMs?: number;
  internalPurpose?: "model-transport";
  body?: FrameBody;
  requestId?: string;
};

export async function getKernelPtr(): Promise<KernelPtr> {
  return await getAgentByName(env.KERNEL, "singleton");
}

export async function getProcessByPid(pid: string): Promise<ProcessPtr> {
  return await getAgentByName(env.PROCESS, pid);
}

export async function sendFrameToKernel(
  processId: string,
  frame: Frame,
): Promise<Frame | null> {
  const kernel = await getKernelPtr();
  return kernel.recvFrame(processId, frame);
}

export async function requestProcessNetFetch(
  processId: string,
  target: string,
  args: NetFetchArgs,
  options: RequestProcessNetFetchOptions = {},
): Promise<ResponseOkFrame<"net.fetch">> {
  const kernel = await getKernelPtr();
  return kernel.requestProcessNetFetch(processId, target, args, options);
}

export async function cancelProcessRequests(
  processId: string,
  requestIds: string[],
  reason?: string,
): Promise<number> {
  const kernel = await getKernelPtr();
  return kernel.cancelProcessRequests(processId, requestIds, reason);
}

export function sendFrameToProcess(
  pid: string,
  frame: ProcessAdapterDeliverRequestFrame,
): Promise<ProcessAdapterDeliverResponseFrame | null>;
export function sendFrameToProcess(
  pid: string,
  frame: ProcessScheduleDeliverRequestFrame,
): Promise<ProcessScheduleDeliverResponseFrame | null>;
export function sendFrameToProcess(
  pid: string,
  frame: ProcessRunAttachRequestFrame,
): Promise<ProcessRunAttachResponseFrame | null>;
export function sendFrameToProcess(
  pid: string,
  frame: Frame,
): Promise<Frame | null>;
export async function sendFrameToProcess(
  pid: string,
  frame: ProcessInboundFrame,
): Promise<
  | Frame
  | ProcessScheduleDeliverResponseFrame
  | ProcessAdapterDeliverResponseFrame
  | ProcessRunAttachResponseFrame
  | null
> {
  const proc = await getProcessByPid(pid);
  return proc.recvFrame(frame);
}
