import { describe, expect, it } from "vitest";
import { bodyFromBytes, bodyFromText } from "@humansandmachines/gsv/protocol";
import { materializeFsRead } from "./fsRead";

describe("materializeFsRead", () => {
  it("decodes text response bodies", async () => {
    await expect(materializeFsRead({
      ok: true,
      path: "/notes.txt",
      size: 6,
      kind: "text",
      contentType: "text/plain",
      lines: 1,
    }, bodyFromText("     1\thello"))).resolves.toMatchObject({
      content: "     1\thello",
    });
  });

  it("converts image response bodies to content blocks", async () => {
    await expect(materializeFsRead({
      ok: true,
      path: "/image.png",
      size: 3,
      kind: "image",
      contentType: "image/png",
    }, bodyFromBytes(new Uint8Array([1, 2, 3])))).resolves.toMatchObject({
      content: [
        { type: "text", text: "Read image /image.png [image/png, 3 bytes]" },
        { type: "image", data: "AQID", mimeType: "image/png" },
      ],
    });
  });

  it("leaves directory results unchanged", async () => {
    const directory = {
      ok: true as const,
      path: "/notes",
      files: ["today.md"],
      directories: ["archive"],
    };

    await expect(materializeFsRead(directory)).resolves.toBe(directory);
  });

  it("rejects file results without a body", async () => {
    await expect(materializeFsRead({
      ok: true,
      path: "/notes.txt",
      size: 6,
      kind: "text",
      contentType: "text/plain",
    })).rejects.toThrow("did not include a body");
  });
});
