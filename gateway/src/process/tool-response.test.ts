import { bodyFromBytes } from "@humansandmachines/gsv/protocol";
import { describe, expect, it } from "vitest";
import { materializeToolResponse } from "./tool-response";

describe("materializeToolResponse", () => {
  it("materializes a routed wearable fs.read body as model image content", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

    const result = await materializeToolResponse(
      "fs.read",
      {
        ok: true,
        path: "/dev/camera/back/snapshot",
        kind: "image",
        contentType: "image/jpeg",
        size: bytes.byteLength,
      },
      bodyFromBytes(bytes),
    );

    expect(result).toEqual({
      ok: true,
      path: "/dev/camera/back/snapshot",
      kind: "image",
      contentType: "image/jpeg",
      size: bytes.byteLength,
      content: [
        {
          type: "text",
          text: "Read image /dev/camera/back/snapshot [image/jpeg, 4 bytes]",
        },
        {
          type: "image",
          data: "/9j/2Q==",
          mimeType: "image/jpeg",
        },
      ],
    });
  });
});
