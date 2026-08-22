import { describe, expect, it } from "vitest";
import {
  chatMediaFilename,
  chatMediaKind,
  chatMediaMimeType,
  chatMediaResource,
  chatMediaSize,
} from "./media";

describe("chat resource media", () => {
  it("projects a validated resource block without inventing a URL", () => {
    const ref = {
      type: "file" as const,
      target: "gsv",
      path: "/root/.gsv/media/archived-media:one",
      revision: '"revision-one"',
      contentType: "image/png",
      size: 3,
    };
    const block = { type: "resource" as const, ref };

    expect(chatMediaResource(block)).toEqual(ref);
    expect(chatMediaKind(block)).toBe("image");
    expect(chatMediaMimeType(block)).toBe("image/png");
    expect(chatMediaFilename(block)).toBe("archived-media:one");
    expect(chatMediaSize(block)).toBe(3);
  });
});
