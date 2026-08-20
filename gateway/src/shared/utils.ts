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
  ProcessRuntimeEventDeliverRequestFrame,
  ProcessRuntimeEventDeliverResponseFrame,
  ProcessScheduleDeliverRequestFrame,
  ProcessScheduleDeliverResponseFrame,
} from "../protocol/process-frames";
import type { NetFetchArgs } from "@humansandmachines/gsv/protocol";
import { getAgentByName } from "agents";
import { SINGLETON_INSTALLATION_ID } from "../installation/identity";
import { getKernelByInstallationId, processDurableObjectName } from "../installation/routing";

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

export async function getKernelPtr(
  installationId: string = SINGLETON_INSTALLATION_ID,
): Promise<KernelPtr> {
  return await getKernelByInstallationId(env.KERNEL, installationId);
}

export async function getProcessByPid(
  pid: string,
  installationId: string = SINGLETON_INSTALLATION_ID,
): Promise<ProcessPtr> {
  return await getAgentByName(env.PROCESS, processDurableObjectName(installationId, pid));
}

export async function sendFrameToKernel(
  installationId: string,
  processId: string,
  frame: Frame,
): Promise<Frame | null> {
  const kernel = await getKernelPtr(installationId);
  return kernel.recvFrame(processId, frame);
}

export async function attachProcessRunStream(
  installationId: string,
  processId: string,
  stream: ReadableStream<Uint8Array>,
): Promise<boolean> {
  const kernel = await getKernelPtr(installationId);
  return await kernel.acceptProcessRunStream(processId, stream);
}

export async function requestProcessNetFetch(
  installationId: string,
  processId: string,
  target: string,
  args: NetFetchArgs,
  options: RequestProcessNetFetchOptions = {},
): Promise<ResponseOkFrame<"net.fetch">> {
  const kernel = await getKernelPtr(installationId);
  return kernel.requestProcessNetFetch(processId, target, args, options);
}

export async function cancelProcessRequests(
  installationId: string,
  processId: string,
  requestIds: string[],
  reason?: string,
): Promise<number> {
  const kernel = await getKernelPtr(installationId);
  return kernel.cancelProcessRequests(processId, requestIds, reason);
}

export function sendFrameToProcess(
  installationId: string,
  pid: string,
  frame: ProcessRuntimeEventDeliverRequestFrame,
): Promise<ProcessRuntimeEventDeliverResponseFrame | null>;
export function sendFrameToProcess(
  installationId: string,
  pid: string,
  frame: ProcessAdapterDeliverRequestFrame,
): Promise<ProcessAdapterDeliverResponseFrame | null>;
export function sendFrameToProcess(
  installationId: string,
  pid: string,
  frame: ProcessScheduleDeliverRequestFrame,
): Promise<ProcessScheduleDeliverResponseFrame | null>;
export function sendFrameToProcess(
  installationId: string,
  pid: string,
  frame: ProcessRunAttachRequestFrame,
): Promise<ProcessRunAttachResponseFrame | null>;
export function sendFrameToProcess(
  installationId: string,
  pid: string,
  frame: Frame,
): Promise<Frame | null>;
export async function sendFrameToProcess(
  installationId: string,
  pid: string,
  frame: ProcessInboundFrame,
): Promise<
  | Frame
  | ProcessRuntimeEventDeliverResponseFrame
  | ProcessScheduleDeliverResponseFrame
  | ProcessAdapterDeliverResponseFrame
  | ProcessRunAttachResponseFrame
  | null
> {
  const proc = await getProcessByPid(pid, installationId);
  return proc.recvFrame(frame);
}
