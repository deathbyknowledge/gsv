import { describe, expect, it } from "vitest";
import {
  chatMediaFilename,
  chatMediaKind,
  chatMediaMimeType,
  chatMediaResource,
  chatMediaSize,
  chatMediaDuration,
  chatMediaTranscription,
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
    const block = {
      type: "resource" as const,
      ref,
      mediaType: "audio" as const,
      filename: "voice-note.ogg",
      duration: 4.5,
      transcription: "hello",
    };

    expect(chatMediaResource(block)).toEqual(ref);
    expect(chatMediaKind(block)).toBe("audio");
    expect(chatMediaMimeType(block)).toBe("image/png");
    expect(chatMediaFilename(block)).toBe("voice-note.ogg");
    expect(chatMediaSize(block)).toBe(3);
    expect(chatMediaDuration(block)).toBe(4.5);
    expect(chatMediaTranscription(block)).toBe("hello");
  });
});
