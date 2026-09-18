import { describe, expect, it } from "vitest";
import { zenAttachment } from "./zenAttachments";

describe("Zen attachment drafts", () => {
  it("keeps the File as a body and identifies its media kind", () => {
    const file = new File(["image bytes"], "image.png", { type: "image/png" });
    expect(zenAttachment(file)).toMatchObject({ body: file, type: "image", mimeType: "image/png", filename: "image.png" });
    expect(zenAttachment(new File([], "notes.txt"))).toMatchObject({ type: "document", mimeType: "application/octet-stream" });
  });

});
