import { byteStreamChunk } from "../../../../packages/gsv/src/protocol/body.js";
import type { SlackTargetResponse } from "./slack-target";

/** Transfers the RPC response's ownership to the returned body. */
export function forwardSlackTargetResponse(response: SlackTargetResponse & Disposable): SlackTargetResponse {
  if (!response.ok || !response.body) {
    try {
      return structuredClone(response);
    } finally {
      response[Symbol.dispose]();
    }
  }
  const reader = response.body.stream.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    reader.releaseLock();
    response[Symbol.dispose]();
  };
  const source: UnderlyingByteSource = {
    type: "bytes",
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          finish();
        } else {
          controller.enqueue(byteStreamChunk(value));
        }
      } catch (error) {
        controller.error(error);
        finish();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  };
  return {
    type: "res",
    id: response.id,
    ok: true,
    data: structuredClone(response.data),
    body: {
      length: response.body.length,
      stream: new ReadableStream(source),
    },
  };
}
