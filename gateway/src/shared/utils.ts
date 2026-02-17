import { ErrorShape, Frame } from "../protocol/frames";

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

export function trimLeadingBlankLines(text: string): string {
  // Keep intentional indentation, but drop blank lines at the start.
  return text.replace(/^(?:[ \t]*\r?\n)+/, "");
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

export class RpcError extends Error {
  code: number;
  details?: unknown;
  retryable?: boolean;

  constructor(
    code: number,
    message: string,
    details?: unknown,
    retryable?: boolean,
  ) {
    super(message);
    this.code = code;
    this.details = details;
    this.retryable = retryable;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function toErrorShape(error: unknown): ErrorShape {
  if (error instanceof RpcError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
      retryable: error.retryable,
    };
  }

  if (error instanceof Error) {
    return {
      code: 500,
      message: error.message,
    };
  }

  return {
    code: 500,
    message: String(error),
  };
}
