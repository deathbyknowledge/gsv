import { Connection, getAgentByName } from "agents";
import { Kernel } from "../kernel/do";
import { env } from "cloudflare:workers";
import { Process } from "../process/do";
import type { RequestFrame, ResponseFrame, Frame } from "../protocol/frames";

export const isWebSocketRequest = (request: Request) =>
  request.method === "GET" && request.headers.get("upgrade") === "websocket";

type ConnState = {
  step: "connect" | "ready";
};

export const isConnectionInit = (connection: Connection<ConnState>) => {
  if (connection.state === null) throw new Error("Connection state is null");
  return connection.state.step === "ready";
};

// don't break the ✨illusion✨
type ProcessPtr = DurableObjectStub<Process>;
type KernelPtr = DurableObjectStub<Kernel>;

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
export async function sendFrameToProcess(
  pid: string,
  frame: Frame,
): Promise<Frame | null> {
  const proc = await getProcessByPid(pid);
  return proc.recvFrame(frame);
}