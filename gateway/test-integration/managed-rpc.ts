import { expect } from "vitest";
import type { TestHarness } from "wrangler";

export type ManagedRpcResponse = {
  type: "res";
  id: string;
  ok: boolean;
  data?: unknown;
  error?: { code?: number; message: string };
};

type HarnessWorker = ReturnType<TestHarness["getWorker"]>;
type HarnessResponse = Awaited<ReturnType<HarnessWorker["fetch"]>>;
export type HarnessWebSocket = NonNullable<HarnessResponse["webSocket"]>;

export async function expectManagedRpcOk(
  socket: HarnessWebSocket,
  id: string,
  call: string,
  args: unknown,
): Promise<ManagedRpcResponse> {
  const response = await expectManagedRpc(socket, id, call, args);
  expect(response).toMatchObject({ type: "res", id, ok: true });
  return response;
}

export async function expectManagedRpc(
  socket: HarnessWebSocket,
  id: string,
  call: string,
  args: unknown,
): Promise<ManagedRpcResponse> {
  const eventSocket = socket as unknown as {
    addEventListener(
      type: "message",
      listener: (event: { data: unknown }) => void,
    ): void;
    removeEventListener(
      type: "message",
      listener: (event: { data: unknown }) => void,
    ): void;
  };
  const responsePromise = new Promise<ManagedRpcResponse>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const onMessage = (event: { data: unknown }) => {
      if (typeof event.data !== "string") return;
      const frame = JSON.parse(event.data) as ManagedRpcResponse;
      if (frame.type !== "res" || frame.id !== id) return;
      eventSocket.removeEventListener("message", onMessage);
      clearTimeout(timeout);
      resolve(frame);
    };
    eventSocket.addEventListener("message", onMessage);
    timeout = setTimeout(() => {
      eventSocket.removeEventListener("message", onMessage);
      reject(new Error(`Timed out waiting for ${call}`));
    }, 5_000);
  });
  socket.send(JSON.stringify({ type: "req", id, call, args }));
  return await responsePromise;
}
