import { describe, expect, it } from "vitest";
import type { FilesFilePayload } from "../../../services/files/domain/models";
import { previewBody } from "./filePreviewModel";

function payload(patch: Partial<FilesFilePayload> = {}): FilesFilePayload {
  return {
    ok: true,
    target: "gsv",
    path: "/notes/file",
    directoryPath: "/notes",
    pathStyle: "absolute",
    content: "hello",
    contentType: null,
    size: 5,
    lines: 1,
    truncated: false,
    ...patch,
  };
}

describe("previewBody", () => {
  it("renders Markdown by extension, whatever its case", () => {
    expect(previewBody("Today.MD", payload({ content: "# Today" }))).toEqual({ kind: "markdown", text: "# Today" });
    expect(previewBody("notes.markdown", payload({ content: "# Notes" }))).toEqual({ kind: "markdown", text: "# Notes" });
  });

  it("renders Markdown by content type with parameters", () => {
    expect(previewBody("README", payload({ content: "# Read me", contentType: "text/markdown; charset=utf-8" })))
      .toEqual({ kind: "markdown", text: "# Read me" });
  });

  it("shows other text as one code block in the extension's language", () => {
    expect(previewBody("deploy.sh", payload({ content: "echo hi" }))).toEqual({ kind: "code", text: "echo hi", language: "sh" });
  });

  it("leaves plain text files and files without an extension unlabelled", () => {
    expect(previewBody("notes.txt", payload())).toEqual({ kind: "code", text: "hello", language: "" });
    expect(previewBody("server.log", payload())).toEqual({ kind: "code", text: "hello", language: "" });
    expect(previewBody("Makefile", payload())).toEqual({ kind: "code", text: "hello", language: "" });
  });

  it("keeps an empty text file as an empty code block", () => {
    expect(previewBody("empty.ts", payload({ content: "", size: 0, lines: 0 }))).toEqual({ kind: "code", text: "", language: "ts" });
  });

  it("shows image content as a data URL", () => {
    const image = payload({
      content: [
        { type: "text", text: "Read image /notes/photo.png [image/png, 3 bytes]" },
        { type: "image", data: "AQID", mimeType: "image/png" },
      ],
    });
    expect(previewBody("photo.png", image)).toEqual({ kind: "image", source: "data:image/png;base64,AQID" });
  });

  it("has nothing to show for array content without an image", () => {
    expect(previewBody("photo.png", payload({ content: [{ type: "text", text: "no image" }] }))).toBeNull();
  });
});
