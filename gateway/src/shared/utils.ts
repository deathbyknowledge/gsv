import { getAgentByName } from "agents";
import { Kernel } from "../kernel/do";
import { env } from "cloudflare:workers";
import { Process } from "../process/do";
import type { Frame, FrameBody, ResponseOkFrame } from "../protocol/frames";
import type { ProcessInboundFrame } from "../protocol/process-frames";
import type { NetFetchArgs } from "@humansandmachines/gsv/protocol";
import type {
  ProcessAuthorityResult,
} from "./process-authority";

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

// One deployed Gateway/storage stack is one ship. Keep this value stable: it
// is the Durable Object name that owns existing Kernel SQLite state.
export const SHIP_KERNEL_NAME = "singleton";

export async function getKernelPtr(
  kernelName: string = SHIP_KERNEL_NAME,
): Promise<KernelPtr> {
  return await getAgentByName(env.KERNEL, kernelName);
}

export async function getProcessByPid(pid: string): Promise<ProcessPtr> {
  return await getAgentByName(env.PROCESS, pid);
}

export async function sendFrameToKernel(
  kernelName: string,
  processId: string,
  frame: Frame,
): Promise<Frame | null> {
  const kernel = await getKernelPtr(kernelName);
  return kernel.recvFrame(processId, frame);
}

export async function resolveProcessAuthority(
  kernelName: string,
  processId: string,
  claimedIdentity: unknown,
): Promise<ProcessAuthorityResult> {
  const kernel = await getKernelPtr(kernelName);
  return kernel.resolveProcessAuthority(processId, claimedIdentity);
}

export async function requestProcessNetFetch(
  kernelName: string,
  processId: string,
  target: string,
  args: NetFetchArgs,
  options: RequestProcessNetFetchOptions = {},
): Promise<ResponseOkFrame<"net.fetch">> {
  const kernel = await getKernelPtr(kernelName);
  return kernel.requestProcessNetFetch(processId, target, args, options);
}

export async function cancelProcessRequests(
  kernelName: string,
  processId: string,
  requestIds: string[],
  reason?: string,
): Promise<number> {
  const kernel = await getKernelPtr(kernelName);
  return kernel.cancelProcessRequests(processId, requestIds, reason);
}

export async function sendFrameToProcess(
  pid: string,
  frame: ProcessInboundFrame,
): Promise<Frame | null> {
  const proc = await getProcessByPid(pid);
  return proc.recvFrame(frame);
}
