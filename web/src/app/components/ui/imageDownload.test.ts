import { describe, expect, it } from "vitest";
import { isDirectDownloadSource } from "./imageDownload";

const PAGE = "https://gsv.example/chat";

describe("isDirectDownloadSource", () => {
  it("downloads our own object URLs and inline data directly", () => {
    expect(isDirectDownloadSource("blob:https://gsv.example/9f1c-4d", PAGE)).toBe(true);
    expect(isDirectDownloadSource("data:image/png;base64,iVBORw0K", PAGE)).toBe(true);
  });

  it("downloads same-origin URLs directly, relative ones included", () => {
    expect(isDirectDownloadSource("https://gsv.example/runtime/media/abc", PAGE)).toBe(true);
    expect(isDirectDownloadSource("/runtime/media/abc", PAGE)).toBe(true);
  });

  it("routes cross-origin URLs through a blob", () => {
    // The download attribute is ignored here, so a plain anchor would navigate
    // the app away instead of downloading.
    expect(isDirectDownloadSource("https://cdn.example.net/photo.jpg", PAGE)).toBe(false);
    expect(isDirectDownloadSource("http://gsv.example/photo.jpg", PAGE)).toBe(false);
    expect(isDirectDownloadSource("https://gsv.example:8443/photo.jpg", PAGE)).toBe(false);
  });

  it("treats an empty or unparseable source as indirect", () => {
    // An empty href would otherwise resolve to the page itself.
    expect(isDirectDownloadSource("", PAGE)).toBe(false);
    expect(isDirectDownloadSource("http://[nonsense", PAGE)).toBe(false);
  });
});
