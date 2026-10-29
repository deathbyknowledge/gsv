import type { GsvBody } from "@humansandmachines/gsv/client";
import { describe, expect, it, vi } from "vitest";
import { fetchLinkPreview, fetchLinkPreviewImage, MAX_LINK_PREVIEW_PAGE_BYTES, pageMetadata } from "./linkPreviewService";

const PAGE = "https://guide.example/start";

function streamOf(chunks: string[] | Uint8Array[]) {
  const cancel = vi.fn();
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) return controller.close();
      const chunk = chunks[index++];
      controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    },
    cancel,
  });
  return { stream, cancel, pulled: () => index };
}

function client(headers: Record<string, string>, body: { stream: ReadableStream<Uint8Array> } | undefined, ok = true) {
  const request = vi.fn(async () => ({
    data: { ok, url: "https://www.guide.example/start", status: ok ? 200 : 404, statusText: "", headers, redirected: true },
    ...(body ? { body: body as GsvBody } : undefined),
  }));
  return { request };
}

describe("link preview metadata", () => {
  it("prefers Open Graph, then Twitter cards, then the title and description", () => {
    expect(pageMetadata(`
      <title>Plain &amp; simple</title>
      <meta name="description" content="Plain description">
      <meta name="twitter:title" content="Twitter title">
      <meta content="Getting &quot;started&quot;" property="og:title">
      <meta property='og:site_name' content='Guide'>
      <meta property="og:image" content="/cover.png">`, PAGE)).toEqual({
      title: 'Getting "started"', description: "Plain description", siteName: "Guide", imageUrl: "https://guide.example/cover.png",
    });
    expect(pageMetadata("<title>\n  Only a  title\n</title>", PAGE)).toEqual({ title: "Only a title" });
  });

  it("ignores an image that is not a web address", () => {
    expect(pageMetadata('<meta property="og:image" content="javascript:alert(1)">', PAGE)).toEqual({});
  });
});

describe("link preview fetch", () => {
  it("reads the page through net.fetch only as far as its head, then cancels the rest", async () => {
    const body = streamOf(['<html><head><meta property="og:title" content="Start">', "</head><body>", "after the head", "never read"]);
    const gateway = client({ "content-type": "text/html; charset=utf-8" }, body);
    await expect(fetchLinkPreview(gateway, PAGE)).resolves.toEqual({
      url: PAGE, resolvedUrl: "https://www.guide.example/start", title: "Start",
    });
    expect(gateway.request).toHaveBeenCalledWith("net.fetch", expect.objectContaining({ url: PAGE, method: "GET", redirect: "follow" }));
    // The stream may pull one chunk ahead of the reader; nothing past that is read.
    expect(body.pulled()).toBeLessThanOrEqual(3);
    expect(body.cancel).toHaveBeenCalled();
  });

  it("stops reading a page whose head never closes at the byte bound", async () => {
    const chunk = "x".repeat(64 * 1024);
    const body = streamOf(Array.from({ length: 10 }, () => chunk));
    await fetchLinkPreview(client({ "content-type": "text/html" }, body), PAGE);
    expect(body.pulled()).toBeLessThanOrEqual(MAX_LINK_PREVIEW_PAGE_BYTES / chunk.length + 1);
    expect(body.cancel).toHaveBeenCalled();
  });

  it("fails without reading a page that is not HTML or did not succeed", async () => {
    const pdf = streamOf(["%PDF"]);
    await expect(fetchLinkPreview(client({ "content-type": "application/pdf" }, pdf), PAGE)).rejects.toThrow("not HTML");
    expect(pdf.cancel).toHaveBeenCalled();
    await expect(fetchLinkPreview(client({ "content-type": "text/html" }, streamOf(["<head>"]), false), PAGE)).rejects.toThrow("status 404");
  });

  it("returns a supported image as a typed blob and refuses other types", async () => {
    const png = streamOf([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]);
    const image = await fetchLinkPreviewImage(client({ "content-type": "image/png" }, png), "https://cdn.example/a.png");
    expect(image.type).toBe("image/png");
    expect(image.size).toBe(4);
    await expect(fetchLinkPreviewImage(client({ "content-type": "image/svg+xml" }, streamOf(["<svg/>"])), "https://cdn.example/a.svg"))
      .rejects.toThrow("not a supported image");
  });
});
