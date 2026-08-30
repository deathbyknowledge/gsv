export type JsonPrimitive = null | boolean | number | string;
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type BodyDescriptor = {
  streamId: number;
  length?: number;
};

export type ControlRequestFrame = {
  type: "req";
  id: string;
  call: string;
  args: JsonValue;
  runId?: string;
  body?: BodyDescriptor;
};

export type ControlResponseFrame =
  | {
      type: "res";
      id: string;
      ok: true;
      data?: JsonValue;
      body?: BodyDescriptor;
    }
  | {
      type: "res";
      id: string;
      ok: false;
      error: {
        code: number;
        message: string;
        details?: JsonValue;
        retryable?: boolean;
      };
    };

export type ControlSignalFrame = {
  type: "sig";
  signal: string;
  payload?: JsonValue;
  seq?: number;
};

export type ControlFrame =
  | ControlRequestFrame
  | ControlResponseFrame
  | ControlSignalFrame;
