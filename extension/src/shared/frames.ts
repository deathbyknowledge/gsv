export type GatewayRequestFrame = {
  type: "req";
  id: string;
  call: string;
  args?: unknown;
};

export type GatewayResponseFrame =
  | {
      type: "res";
      id: string;
      ok: true;
      data?: unknown;
    }
  | {
      type: "res";
      id: string;
      ok: false;
      error: {
        code: number;
        message: string;
        details?: unknown;
        retryable?: boolean;
      };
    };

export type GatewaySignalFrame = {
  type: "sig";
  signal: string;
  payload?: unknown;
  seq?: number;
};

export type GatewayFrame = GatewayRequestFrame | GatewayResponseFrame | GatewaySignalFrame;

export function isRequestFrame(frame: GatewayFrame): frame is GatewayRequestFrame {
  return frame.type === "req" && typeof frame.id === "string" && typeof frame.call === "string";
}

export function okFrame(id: string, data: unknown): GatewayResponseFrame {
  return { type: "res", id, ok: true, data };
}

export function errorFrame(id: string, code: number, message: string, details?: unknown): GatewayResponseFrame {
  return {
    type: "res",
    id,
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}
