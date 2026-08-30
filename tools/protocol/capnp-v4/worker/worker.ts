import { decodeV4BinaryMessage, encodeV4ControlMessage } from "../src/codec";

export default {
  async fetch(request: Request): Promise<Response> {
    const message = decodeV4BinaryMessage(await request.arrayBuffer());
    if (message.kind !== "control") return new Response("expected control frame", { status: 400 });
    return new Response(encodeV4ControlMessage(message.frame, { packed: message.packed }), {
      headers: {
        "content-type": "application/x-capnp",
        "x-capnp-packed": message.packed ? "1" : "0",
      },
    });
  },
};
