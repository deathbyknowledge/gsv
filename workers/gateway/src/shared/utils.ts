import { env } from "cloudflare:workers";
import type { Kernel } from "../kernel/do";
import type { Process } from "../process/do";
import type {
  Frame,
  FrameBody,
  RequestFrame,
  ResponseFrame,
  ResponseOkFrame,
} from "../protocol/frames";
import type { SyscallName } from "../syscalls";
import type {
  ProcessEventDeliverArgs,
  ProcessEventDeliverResult,
  ProcessInboundFrame,
  ProcessMessageCommitArgs,
  ProcessOutboundFrame,
  ProcessApprovalTarget,
  ProcessResourcesRetainArgs,
  ProcessResourceWriteArgs,
  ProcessRunAttachArgs,
  ProcessRunAttachResult,
  ProcessRunStagedArgs,
  ProcessRunStagedResult,
  ProcessToolAuthorizeArgs,
  ProcessUnavailable,
} from "../protocol/process-frames";
import type { ConversationMessage, NetFetchArgs, ResourceBlock } from "@humansandmachines/gsv/protocol";
import {
  conversationDurableObjectName,
  getKernelByInstallationId,
  processDurableObjectName,
} from "../installation/routing";
import type { Conversation } from "../conversation/do";

export const isWebSocketRequest = (request: Request) =>
  request.method === "GET" && request.headers.get("upgrade") === "websocket";

// don't break the ✨illusion✨
type ProcessPtr = DurableObjectStub<undefined> & Process;
type KernelPtr = DurableObjectStub<undefined> & Kernel;

export type RequestProcessNetFetchOptions = {
  ttlMs?: number;
  internalPurpose?: "model-transport";
  body?: FrameBody;
  requestId?: string;
};

export async function getKernelPtr(
  installationId: string,
): Promise<KernelPtr> {
  const stub: unknown = await getKernelByInstallationId(
    env.KERNEL,
    installationId,
  );
  // SAFETY: the namespace is generated from the exported Kernel class; this
  // narrows only Cloudflare's recursively mapped RPC stub type.
  return stub as KernelPtr;
}

export async function getProcessByPid(
  pid: string,
  installationId: string,
): Promise<ProcessPtr> {
  const stub: unknown = env.PROCESS.getByName(
    processDurableObjectName(installationId, pid),
  );
  // SAFETY: the namespace is generated from the exported Process class; this
  // narrows only Cloudflare's recursively mapped RPC stub type.
  return stub as ProcessPtr;
}

/** The response correlated with one request frame, or any frame for non-requests. */
export type ResponseTo<F> = F extends { type: "req"; call: infer C }
  ? C extends SyscallName
    ? ResponseFrame<C>
    : never
  : Frame;

export function sendFrameToKernel<S extends SyscallName>(
  installationId: string,
  processId: string,
  frame: RequestFrame<S>,
  approvedTarget?: ProcessApprovalTarget,
): Promise<ResponseFrame<S> | null>;
export function sendFrameToKernel<F extends ProcessOutboundFrame>(
  installationId: string,
  processId: string,
  frame: F,
  approvedTarget?: ProcessApprovalTarget,
): Promise<ResponseTo<F> | null>;
export async function sendFrameToKernel(
  installationId: string,
  processId: string,
  frame: ProcessOutboundFrame,
  approvedTarget?: ProcessApprovalTarget,
): Promise<Frame | null> {
  const kernel = await getKernelPtr(installationId);
  return await kernel.recvFrame(processId, frame, approvedTarget);
}

export async function commitProcessMessage(
  installationId: string,
  processId: string,
  args: ProcessMessageCommitArgs,
): Promise<ConversationMessage> {
  const kernel = await getKernelPtr(installationId);
  return await kernel.commitProcessMessage(processId, args);
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

export function sendFrameToProcess<S extends SyscallName>(
  installationId: string,
  pid: string,
  frame: RequestFrame<S>,
): Promise<ResponseFrame<S> | null>;
export function sendFrameToProcess<F extends ProcessInboundFrame>(
  installationId: string,
  pid: string,
  frame: F,
): Promise<ResponseTo<F> | null>;
export async function sendFrameToProcess(
  installationId: string,
  pid: string,
  frame: ProcessInboundFrame,
): Promise<Frame | null> {
  const proc = await getProcessByPid(pid, installationId);
  return await proc.recvFrame(frame);
}

export async function deliverEventToProcess(
  installationId: string,
  pid: string,
  args: ProcessEventDeliverArgs,
): Promise<ProcessEventDeliverResult | ProcessUnavailable> {
  const proc = await getProcessByPid(pid, installationId);
  return await proc.deliverEvent(args);
}

/** Asks the Process that owns a tool whether an operation nested under it may run. */
export async function authorizeProcessTool(
  installationId: string,
  pid: string,
  cancelId: string,
  args: ProcessToolAuthorizeArgs,
): Promise<{ approved: boolean } | ProcessUnavailable> {
  const proc = await getProcessByPid(pid, installationId);
  return await proc.authorizeTool(cancelId, args);
}

export async function retainProcessResources(
  installationId: string,
  pid: string,
  cancelId: string,
  args: ProcessResourcesRetainArgs,
): Promise<{ resources: ResourceBlock[] } | ProcessUnavailable> {
  const proc = await getProcessByPid(pid, installationId);
  return await proc.retainResources(cancelId, args);
}

/** Cancels a call the Kernel made to a Process under `cancelId`. */
export async function cancelProcessCall(
  installationId: string,
  pid: string,
  cancelId: string,
  reason: string,
): Promise<void> {
  const proc = await getProcessByPid(pid, installationId);
  await proc.cancelCall(cancelId, reason);
}

export async function writeProcessResource(
  installationId: string,
  pid: string,
  args: ProcessResourceWriteArgs,
  body: FrameBody,
): Promise<{ resource: ResourceBlock } | ProcessUnavailable> {
  const proc = await getProcessByPid(pid, installationId);
  return await proc.writeResource(args, body);
}

export async function attachProcessRunMedia(
  installationId: string,
  pid: string,
  args: ProcessRunAttachArgs,
): Promise<ProcessRunAttachResult | ProcessUnavailable> {
  const proc = await getProcessByPid(pid, installationId);
  return await proc.attachRunMedia(args);
}

export async function countProcessStagedRunMedia(
  installationId: string,
  pid: string,
  args: ProcessRunStagedArgs,
): Promise<ProcessRunStagedResult | ProcessUnavailable> {
  const proc = await getProcessByPid(pid, installationId);
  return await proc.countStagedRunMedia(args);
}

export function getConversationById(
  installationId: string,
  conversationId: string,
): DurableObjectStub<Conversation> {
  const name = conversationDurableObjectName(installationId, conversationId);
  return env.CONVERSATION.get(env.CONVERSATION.idFromName(name));
}
