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
import { SHIP_KERNEL_NAME } from "./kernel-names";

export { SHIP_KERNEL_NAME } from "./kernel-names";

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

export async function resolveProcessTeardownAuthority(
  kernelName: string,
  processId: string,
  claimedIdentity: unknown,
): Promise<ProcessAuthorityResult> {
  const kernel = await getKernelPtr(kernelName);
  return kernel.resolveProcessTeardownAuthority(processId, claimedIdentity);
}

export async function resolveProcessLifecycleFenceAuthority(
  kernelName: string,
  processId: string,
  claimedIdentity: unknown,
  fencedGeneration: number,
): Promise<ProcessAuthorityResult> {
  const kernel = await getKernelPtr(kernelName);
  return kernel.resolveProcessLifecycleFenceAuthority(
    processId,
    claimedIdentity,
    fencedGeneration,
  );
}

export async function resolveProcessPackageProjectionFenceAuthority(
  kernelName: string,
  processId: string,
  claimedIdentity: unknown,
  fencedGeneration: number,
  fenceId: string,
): Promise<ProcessAuthorityResult> {
  const kernel = await getKernelPtr(kernelName);
  return kernel.resolveProcessPackageProjectionFenceAuthority(
    processId,
    claimedIdentity,
    fencedGeneration,
    fenceId,
  );
}

export async function consumeProcessRollbackAuthorization(
  kernelName: string,
  processId: string,
  authorization: string,
): Promise<boolean> {
  const kernel = await getKernelPtr(kernelName);
  return kernel.consumeProcessRollbackAuthorization({
    processId,
    authorization,
  });
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
