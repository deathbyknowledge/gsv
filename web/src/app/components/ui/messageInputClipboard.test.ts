import { describe, expect, it } from "vitest";
import { clipboardImageFiles } from "./messageInputClipboard";

function item(file: File, type = file.type): DataTransferItem {
  return {
    kind: "file",
    type,
    getAsFile: () => file,
  } as DataTransferItem;
}

describe("clipboardImageFiles", () => {
  it("uses clipboard item MIME type when pasted image files have empty metadata", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "", { type: "" });
    const files = clipboardImageFiles({
      items: [item(file, "image/png")],
      files: [],
    });

    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("pasted-image-1.png");
    expect(files[0].type).toBe("image/png");
    expect(new Uint8Array(await files[0].arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("falls back to DataTransfer files", () => {
    const image = new File(["image"], "screenshot.webp", { type: "" });
    const text = new File(["text"], "notes.txt", { type: "text/plain" });

    expect(clipboardImageFiles({
      items: [],
      files: [image, text],
    })).toEqual([image]);
  });

  it("extracts data-url images from pasted HTML", async () => {
    const files = clipboardImageFiles({
      items: [],
      files: [],
      getData: (format) => format === "text/html"
        ? '<img src="data:image/png;base64,AQID">'
        : "",
    });

    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("pasted-image-1.png");
    expect(files[0].type).toBe("image/png");
    expect(new Uint8Array(await files[0].arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});
