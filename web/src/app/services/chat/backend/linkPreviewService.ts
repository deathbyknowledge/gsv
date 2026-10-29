import type { GSVClient } from "@humansandmachines/gsv/client";
import { bodyToBytes } from "@humansandmachines/gsv/protocol";
import { z } from "zod";

type LinkPreviewGsvClient = Pick<GSVClient, "request">;

export type LinkPreview = {
  url: string;
  resolvedUrl: string;
  title?: string;
  description?: string;
  siteName?: string;
  imageUrl?: string;
};

/** A page's preview tags sit in its head; reading stops there, or at this many bytes. */
export const MAX_LINK_PREVIEW_PAGE_BYTES = 256 * 1024;
export const MAX_LINK_PREVIEW_IMAGE_BYTES = 2 * 1024 * 1024;
const LINK_PREVIEW_TIMEOUT_MS = 8_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** Previews share the Kernel's few outbound connections with Ship's own work, so only a few are read at once. */
const MAX_PREVIEW_FETCHES = 4;
let activeFetches = 0;
const waiting: Array<() => void> = [];

async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (activeFetches >= MAX_PREVIEW_FETCHES) await new Promise<void>((resolve) => waiting.push(resolve));
  activeFetches += 1;
  try {
    return await task();
  } finally {
    activeFetches -= 1;
    waiting.shift()?.();
  }
}

const netFetchDataSchema = z.object({
  ok: z.boolean(),
  url: z.string(),
  status: z.number(),
  headers: z.record(z.string(), z.string()),
});

/**
 * Reads a page through `net.fetch` on `gsv`, which relays the response as it arrives, and parses its preview tags here.
 * Only the head is read; the rest of the body is cancelled, which also stops the Kernel's request to the site.
 */
export function fetchLinkPreview(client: LinkPreviewGsvClient, url: string): Promise<LinkPreview> {
  return limited(() => readLinkPreview(client, url));
}

async function readLinkPreview(client: LinkPreviewGsvClient, url: string): Promise<LinkPreview> {
  const response = await client.request("net.fetch", {
    url,
    method: "GET",
    headers: { accept: "text/html,application/xhtml+xml;q=0.9" },
    redirect: "follow",
    timeoutMs: LINK_PREVIEW_TIMEOUT_MS,
  });
  const data = netFetchDataSchema.parse(response.data);
  const contentType = data.headers["content-type"] ?? "";
  if (!data.ok || !/^\s*(text\/html|application\/xhtml\+xml)\b/i.test(contentType) || !response.body) {
    await response.body?.stream.cancel().catch(() => {});
    throw new Error(`Link preview page is not HTML (status ${data.status})`);
  }
  const head = await readHead(response.body.stream, charset(contentType));
  return { url, resolvedUrl: data.url || url, ...pageMetadata(head, data.url || url) };
}

/** The image travels through `net.fetch` too, so the browser never contacts the image host. */
export function fetchLinkPreviewImage(client: LinkPreviewGsvClient, url: string): Promise<Blob> {
  return limited(() => readLinkPreviewImage(client, url));
}

async function readLinkPreviewImage(client: LinkPreviewGsvClient, url: string): Promise<Blob> {
  const response = await client.request("net.fetch", {
    url,
    method: "GET",
    headers: { accept: [...IMAGE_TYPES].join(",") },
    redirect: "follow",
    timeoutMs: LINK_PREVIEW_TIMEOUT_MS,
  });
  const data = netFetchDataSchema.parse(response.data);
  const mimeType = (data.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (!data.ok || !IMAGE_TYPES.has(mimeType) || !response.body) {
    await response.body?.stream.cancel().catch(() => {});
    throw new Error(`Link preview image is not a supported image (status ${data.status})`);
  }
  const bytes = await bodyToBytes(response.body, MAX_LINK_PREVIEW_IMAGE_BYTES);
  return new Blob([new Uint8Array(bytes)], { type: mimeType });
}

/** Reads text until the head closes or the byte bound is reached, then cancels whatever is left. */
async function readHead(stream: ReadableStream<Uint8Array>, encoding: string): Promise<string> {
  const reader = stream.getReader();
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding);
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  let text = "";
  let read = 0;
  try {
    while (read < MAX_LINK_PREVIEW_PAGE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      text += decoder.decode(value, { stream: true });
      const end = text.search(/<\/head\s*>|<body[\s>]/i);
      if (end >= 0) return text.slice(0, end);
    }
    return text;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function charset(contentType: string): string {
  return /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1] ?? "utf-8";
}

/** Open Graph first, then Twitter cards, then the plain title and description. */
export function pageMetadata(head: string, pageUrl: string): Omit<LinkPreview, "url" | "resolvedUrl"> {
  const tags = new Map<string, string>();
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = tagAttributes(tag);
    const name = (attributes.get("property") ?? attributes.get("name"))?.toLowerCase();
    const content = attributes.get("content")?.trim();
    if (name && content && !tags.has(name)) tags.set(name, content);
  }
  const meta = (...names: string[]) => names.map((name) => tags.get(name)).find(Boolean);
  const plainTitle = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1];
  const title = meta("og:title", "twitter:title") ?? (plainTitle ? decodeEntities(plainTitle).replace(/\s+/g, " ").trim() || undefined : undefined);
  const description = meta("og:description", "twitter:description", "description");
  const siteName = meta("og:site_name");
  const image = meta("og:image:secure_url", "og:image", "twitter:image");
  let imageUrl: string | undefined;
  if (image) {
    try {
      const resolved = new URL(image, pageUrl);
      if (resolved.protocol === "https:" || resolved.protocol === "http:") imageUrl = resolved.href;
    } catch {
      imageUrl = undefined;
    }
  }
  return {
    ...(title ? { title: title.slice(0, 300) } : undefined),
    ...(description ? { description: description.slice(0, 500) } : undefined),
    ...(siteName ? { siteName: siteName.slice(0, 100) } : undefined),
    ...(imageUrl ? { imageUrl } : undefined),
  };
}

function tagAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const [, name, doubleQuoted, singleQuoted, bare] of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attributes.set(name.toLowerCase(), decodeEntities(doubleQuoted ?? singleQuoted ?? bare ?? ""));
  }
  return attributes;
}

const NAMED_ENTITIES = new Map([["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"], ["nbsp", "\u00a0"]]);

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] !== "#") return NAMED_ENTITIES.get(code.toLowerCase()) ?? entity;
    const point = code[1].toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}
