import { Connection, getCurrentAgent } from "agents";
import { Kernel } from "../kernel/do";

export const isWebSocketRequest = (request: Request) =>
  request.method === "GET" && request.headers.get("upgrade") === "websocket";

type ConnState = {
  step: "connect" | "ready";
};

export const isConnectionInit = (connection: Connection<ConnState>) => {
  if (connection.state === null) throw new Error("Connection state is null");
  return connection.state.step === "ready";
};

export function getKernelPtr(skipConnection = false) {
  const { agent, connection } = getCurrentAgent<Kernel>();

  if (!agent) {
    throw new Error(
      "Kernel not found. Did you use getKernelPtr() outside the DO?",
    );
  }

  if (!skipConnection && !connection) {
    throw new Error(
      "Connection not found. Did you mean to use getKernelPtr(true)?",
    );
  }

  return { kernel: agent, connection };
}
