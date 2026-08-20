import { describe, expect, it } from "vitest";

import {
  extractToolResultImages,
  materializeLegacyToolResultImages,
  unwrapStoredToolResult,
  wrapStoredToolResult,
} from "./tool-result-media";

describe("tool result media", () => {
  it("extracts nested image bytes and leaves a durable placeholder", () => {
    const extracted = extractToolResultImages({
      ok: true,
      content: [
        { type: "text", text: "camera snapshot" },
        { type: "image", data: "AQID", mimeType: "image/png" },
      ],
    }, { maxImages: 20, maxBytes: 1024 });

    expect(extracted.images).toHaveLength(1);
    expect([...extracted.images[0]!.bytes]).toEqual([1, 2, 3]);
    expect(extracted.output).toEqual({
      ok: true,
      content: [
        { type: "text", text: "camera snapshot" },
        { type: "image", mimeType: "image/png" },
      ],
    });
    expect(JSON.stringify(extracted.output)).not.toContain("AQID");

    extracted.images[0]!.placeholder.path = "/var/media/0/pid/image";
    extracted.images[0]!.placeholder.size = 3;
    expect(extracted.output).toMatchObject({
      content: [
        { type: "text" },
        {
          type: "image",
          mimeType: "image/png",
          path: "/var/media/0/pid/image",
          size: 3,
        },
      ],
    });
  });

  it("rejects invalid and oversized image data without echoing it", () => {
    expect(() => extractToolResultImages(
      { type: "image", data: "%%%", mimeType: "image/png" },
      { maxImages: 1, maxBytes: 1024 },
    )).toThrow("not valid base64");
    expect(() => extractToolResultImages(
      { type: "image", data: "AQID", mimeType: "image/png" },
      { maxImages: 1, maxBytes: 2 },
    )).toThrow("exceed");
  });

  it("wraps references without confusing legacy tool results", () => {
    const media = [{
      type: "image" as const,
      mimeType: "image/png",
      key: "var/media/0/pid/image",
    }];
    const wrapped = wrapStoredToolResult({ ok: true }, media);

    expect(unwrapStoredToolResult(wrapped)).toEqual({
      output: { ok: true },
      media,
    });
    expect(unwrapStoredToolResult({ ok: true })).toEqual({
      output: { ok: true },
      media: [],
    });
  });

  it("restores legacy JSON-stringified images as typed content", () => {
    const content = JSON.stringify({
      ok: true,
      content: [
        { type: "text", text: "old snapshot" },
        { type: "image", data: "AQID", mimeType: "image/png" },
      ],
    });

    const blocks = materializeLegacyToolResultImages(content);

    expect(blocks).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          content: [
            { type: "text", text: "old snapshot" },
            { type: "image", mimeType: "image/png" },
          ],
        }),
      },
      { type: "image", data: "AQID", mimeType: "image/png" },
    ]);
  });
});
