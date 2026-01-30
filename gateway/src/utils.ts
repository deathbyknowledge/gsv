import { Frame } from "./types";

export const isWebSocketRequest = (request: Request) =>
  request.method === "GET" && request.headers.get("upgrade") === "websocket";

export const validateFrame = (frame: Frame) => {
  const ok = ["req", "res", "evt"].includes(frame.type);
  if (!ok) throw new Error("Invalid frame");
};

export const isWsConnected = (ws: WebSocket) => {
  const { connected } = ws.deserializeAttachment();
  return !!connected;
};
