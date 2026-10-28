import type {
  BinaryBody,
  ConversationLinkImageResult,
  ConversationLinkPreview,
  ConversationLinkPreviewResult,
} from "@humansandmachines/gsv/protocol";
import { sniffImageMimeType } from "../inference/image-mime";
import { raceWithAbort } from "../shared/abort";
import { isPublicHostname } from "./public-destination";

export type LinkPreviewFailureCategory = "unsupported" | "blocked" | "unreachable" | "too-large" | "timeout";

/** A preview fetch that failed for a reason the client may show by category. */
export class LinkPreviewFailure extends Error {
  constructor(readonly category: LinkPreviewFailureCategory, message: string) {
    super(message);
    this.name = "LinkPreviewFailure";
  }
}

export type LinkPreviewOptions = {
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  timeoutMs?: number;
  deadlineMs?: number;
};

type FetchOptions = {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  timeoutMs: number;
  /** Aborts every request of one preview once its overall deadline passes. */
  signal?: AbortSignal;
};

type PageMetadata = {
  title?: string;
  description?: string;
  siteName?: string;
  image?: { url: string; width?: number; height?: number };
};

type FetchedImage = { url: URL; bytes: Uint8Array; mimeType: string };
type PreviewImage = FetchedImage & { width?: number; height?: number };

type LinkPreviewRow = {
  url: string;
  resolved_url: string | null;
  title: string | null;
  description: string | null;
  site_name: string | null;
  image_key: string | null;
  image_mime: string | null;
  image_size: number | null;
  image_width: number | null;
  image_height: number | null;
  error: LinkPreviewFailureCategory | null;
  fetched_at: number;
  expires_at: number;
};

const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 5_000;
/** The whole preview, page and image across every permitted redirect, stays well inside the client's request timeout. */
export const LINK_PREVIEW_DEADLINE_MS = 15_000;
export const MAX_LINK_PREVIEW_PAGE_BYTES = 512 * 1024;
export const MAX_LINK_PREVIEW_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_SITE_NAME_LENGTH = 200;
const MAX_IMAGE_DIMENSION = 100_000;
export const LINK_PREVIEW_SUCCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LINK_PREVIEW_FAILURE_TTL_MS = 60 * 60 * 1000;
const PRUNE_BATCH = 100;
/** Kernel-owned image bytes, written as root-owned read-only objects so filesystem callers cannot replace them. */
export const LINK_PREVIEW_IMAGE_PREFIX = "var/cache/link-previews/";
const IMAGE_PURPOSE = "link-preview";
const USER_AGENT = "GSV-LinkPreview/1.0 (+https://gsv.space)";
const PAGE_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1";
const IMAGE_ACCEPT = "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9";
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const IMAGE_KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Returns the URL the Kernel may fetch for a preview, without its fragment.
 * The model chooses these URLs, so only absolute http(s) URLs on the default
 * port whose host is publicly reachable pass. A Worker cannot resolve DNS
 * itself, so a public name that resolves to a private address is left to the
 * platform's egress rules; every redirect hop is checked again here.
 */
export function previewableUrl(value: string): URL {
  if (value.length === 0 || value.length > MAX_URL_LENGTH) {
    throw new LinkPreviewFailure("unsupported", "Link preview URL is empty or too long");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LinkPreviewFailure("unsupported", "Link preview URL is not absolute");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LinkPreviewFailure("unsupported", "Link previews support only http and https");
  }
  if (url.username || url.password) {
    throw new LinkPreviewFailure("blocked", "Link preview URLs cannot contain credentials");
  }
  // The URL parser clears a port equal to the scheme's default.
  if (url.port !== "") {
    throw new LinkPreviewFailure("blocked", "Link previews use only the default port");
  }
  if (!isPublicHostname(url.hostname)) {
    throw new LinkPreviewFailure("blocked", "Link preview host is not publicly reachable");
  }
  url.hash = "";
  return url;
}

/** Owns link preview fetches, their SQLite cache and the image objects that cache refers to. */
export class LinkPreviews {
  private readonly inflight = new Map<string, Promise<LinkPreviewRow>>();
  private readonly imageLocks = new Map<string, Promise<void>>();
  private readonly fetchOptions: FetchOptions;
  private readonly now: () => number;
  private readonly deadlineMs: number;
  private pruning: Promise<void> | null = null;

  constructor(
    private readonly sql: SqlStorage,
    private readonly storage: R2Bucket,
    options: LinkPreviewOptions = {},
  ) {
    this.fetchOptions = {
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
      timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    };
    this.deadlineMs = options.deadlineMs ?? LINK_PREVIEW_DEADLINE_MS;
    this.now = options.now ?? Date.now;
  }

  async preview(requested: string): Promise<ConversationLinkPreviewResult> {
    let url: URL;
    try {
      url = previewableUrl(requested);
    } catch (error) {
      return { ok: false, error: failureCategory(error) };
    }
    this.pruneInBackground();
    const row = this.cached(url.href) ?? await this.refresh(url.href);
    return previewResult(requested, row);
  }

  /** Cleanup runs beside a request, never ahead of it, so a preview answers within its own deadline; one pass at a time. */
  private pruneInBackground(): void {
    if (this.pruning) return;
    this.pruning = this.pruneExpired()
      .catch((error) => console.warn("[LinkPreviews] Pruning expired previews failed:", errorName(error)))
      .finally(() => { this.pruning = null; });
  }

  /** Resolves once any background pruning has finished. */
  async settled(): Promise<void> {
    await this.pruning;
  }

  async image(key: string): Promise<{ data: ConversationLinkImageResult; body?: BinaryBody }> {
    if (!IMAGE_KEY_PATTERN.test(key)) return { data: { ok: false, error: "unsupported" } };
    if (!this.referenced(key)) return { data: { ok: false, error: "not-found" } };
    const object = await this.storage.get(LINK_PREVIEW_IMAGE_PREFIX + key);
    if (!object) return { data: { ok: false, error: "not-found" } };
    const mimeType = object.httpMetadata?.contentType ?? "";
    if (object.customMetadata?.purpose !== IMAGE_PURPOSE || object.customMetadata.uid !== "0" || !IMAGE_TYPES.has(mimeType)) {
      await object.body.cancel().catch(() => {});
      return { data: { ok: false, error: "not-found" } };
    }
    return {
      data: { ok: true, key, mimeType, size: object.size },
      body: { stream: object.body, length: object.size },
    };
  }

  /** Deletes a bounded batch of expired rows and any image no remaining row refers to. */
  async pruneExpired(): Promise<void> {
    const expired = this.sql.exec<{ image_key: string | null }>(
      `DELETE FROM link_previews
        WHERE url IN (SELECT url FROM link_previews WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)
        RETURNING image_key`,
      this.now(),
      PRUNE_BATCH,
    ).toArray();
    const keys = new Set(expired.flatMap((row) => row.image_key ? [row.image_key] : []));
    for (const key of keys) await this.releaseImage(key);
  }

  private cached(url: string): LinkPreviewRow | null {
    return this.sql.exec<LinkPreviewRow>(
      "SELECT * FROM link_previews WHERE url = ? AND expires_at > ?",
      url,
      this.now(),
    ).toArray()[0] ?? null;
  }

  private refresh(url: string): Promise<LinkPreviewRow> {
    const existing = this.inflight.get(url);
    if (existing) return existing;
    const pending = this.fetchAndStore(url).finally(() => this.inflight.delete(url));
    this.inflight.set(url, pending);
    return pending;
  }

  private async fetchAndStore(url: string): Promise<LinkPreviewRow> {
    const { row, image, imageAdvertised } = await this.fetchRow(url);
    const stored = image ? await this.storeWithImage(row, image) : null;
    // A page whose advertised image could not be fetched or stored keeps the failure expiry, so the image is retried within the hour.
    const saved = stored?.row ?? (imageAdvertised ? { ...row, expires_at: row.fetched_at + LINK_PREVIEW_FAILURE_TTL_MS } : row);
    const previous = stored ? stored.previous : this.upsert(saved);
    // Released after the new key's lock, so two saves never wait on each other's keys.
    if (previous && previous !== saved.image_key) await this.releaseImage(previous);
    return saved;
  }

  /** Writes the image object and the row that refers to it under the image key's lock; null when the image could not be stored. */
  private async storeWithImage(
    row: LinkPreviewRow,
    image: PreviewImage,
  ): Promise<{ row: LinkPreviewRow; previous: string | null } | null> {
    const key = await sha256Hex(image.url.href);
    return this.withImageLock(key, async () => {
      try {
        await this.storage.put(LINK_PREVIEW_IMAGE_PREFIX + key, image.bytes, {
          httpMetadata: { contentType: image.mimeType },
          customMetadata: { purpose: IMAGE_PURPOSE, uid: "0", gid: "0", mode: "400" },
        });
      } catch (error) {
        console.warn("[LinkPreviews] Failed to store a preview image:", errorName(error));
        return null;
      }
      const withImage: LinkPreviewRow = {
        ...row,
        image_key: key,
        image_mime: image.mimeType,
        image_size: image.bytes.byteLength,
        image_width: image.width ?? null,
        image_height: image.height ?? null,
      };
      return { row: withImage, previous: this.upsert(withImage) };
    });
  }

  private async fetchRow(url: string): Promise<{ row: LinkPreviewRow; image: PreviewImage | null; imageAdvertised: boolean }> {
    const fetchedAt = this.now();
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort(new LinkPreviewFailure("timeout", "Link preview took too long"));
    }, this.deadlineMs);
    const options: FetchOptions = { ...this.fetchOptions, signal: deadline.signal };
    let page: { resolvedUrl: URL; metadata: PageMetadata };
    try {
      page = await fetchPage(new URL(url), options);
    } catch (error) {
      clearTimeout(timer);
      return {
        row: { ...emptyRow(url, fetchedAt, fetchedAt + LINK_PREVIEW_FAILURE_TTL_MS), error: failureCategory(error) },
        image: null,
        imageAdvertised: false,
      };
    }
    const { metadata } = page;
    let image: FetchedImage | null = null;
    try {
      if (metadata.image) image = await fetchPreviewImage(metadata.image.url, page.resolvedUrl, options);
    } finally {
      clearTimeout(timer);
    }
    return {
      row: {
        ...emptyRow(url, fetchedAt, fetchedAt + LINK_PREVIEW_SUCCESS_TTL_MS),
        resolved_url: page.resolvedUrl.href,
        title: metadata.title ?? null,
        description: metadata.description ?? null,
        site_name: metadata.siteName ?? null,
      },
      image: image ? { ...image, width: metadata.image?.width, height: metadata.image?.height } : null,
      imageAdvertised: Boolean(metadata.image),
    };
  }

  /** Replaces the row for its URL and returns the image key the replaced row referred to. */
  private upsert(row: LinkPreviewRow): string | null {
    const previous = this.sql.exec<{ image_key: string | null }>(
      "SELECT image_key FROM link_previews WHERE url = ?",
      row.url,
    ).toArray()[0]?.image_key ?? null;
    this.sql.exec(
      `INSERT OR REPLACE INTO link_previews
        (url, resolved_url, title, description, site_name, image_key, image_mime, image_size,
         image_width, image_height, error, fetched_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.url,
      row.resolved_url,
      row.title,
      row.description,
      row.site_name,
      row.image_key,
      row.image_mime,
      row.image_size,
      row.image_width,
      row.image_height,
      row.error,
      row.fetched_at,
      row.expires_at,
    );
    return previous;
  }

  private referenced(key: string): boolean {
    return this.sql.exec("SELECT 1 FROM link_previews WHERE image_key = ? LIMIT 1", key).toArray().length > 0;
  }

  private releaseImage(key: string): Promise<void> {
    return this.withImageLock(key, async () => {
      if (this.referenced(key)) return;
      try {
        await this.storage.delete(LINK_PREVIEW_IMAGE_PREFIX + key);
      } catch (error) {
        console.warn("[LinkPreviews] Failed to delete an unreferenced preview image:", errorName(error));
      }
    });
  }

  /** Serializes the writes and deletions of one image key against its row references. */
  private async withImageLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.imageLocks.get(key) ?? Promise.resolve();
    const result = prior.then(operation);
    const tail = result.then(() => {}, () => {});
    this.imageLocks.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.imageLocks.get(key) === tail) this.imageLocks.delete(key);
    }
  }
}

function emptyRow(url: string, fetchedAt: number, expiresAt: number): LinkPreviewRow {
  return {
    url,
    resolved_url: null,
    title: null,
    description: null,
    site_name: null,
    image_key: null,
    image_mime: null,
    image_size: null,
    image_width: null,
    image_height: null,
    error: null,
    fetched_at: fetchedAt,
    expires_at: expiresAt,
  };
}

function previewResult(requested: string, row: LinkPreviewRow): ConversationLinkPreviewResult {
  if (row.error || !row.resolved_url) return { ok: false, error: row.error ?? "unreachable" };
  const preview: ConversationLinkPreview = {
    url: requested,
    resolvedUrl: row.resolved_url,
    ...(row.title ? { title: row.title } : undefined),
    ...(row.description ? { description: row.description } : undefined),
    ...(row.site_name ? { siteName: row.site_name } : undefined),
  };
  if (row.image_key && row.image_mime && row.image_size !== null) {
    preview.image = {
      key: row.image_key,
      mimeType: row.image_mime,
      size: row.image_size,
      ...(row.image_width !== null ? { width: row.image_width } : undefined),
      ...(row.image_height !== null ? { height: row.image_height } : undefined),
    };
  }
  return { ok: true, preview };
}

async function fetchPage(url: URL, options: FetchOptions): Promise<{ resolvedUrl: URL; metadata: PageMetadata }> {
  const fetched = await guardedFetch(url, PAGE_ACCEPT, options);
  const { response } = fetched;
  try {
    if (!response.ok) throw new LinkPreviewFailure("unreachable", `Page responded with status ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!HTML_TYPES.has(mediaType(contentType)) || !response.body) {
      return { resolvedUrl: fetched.url, metadata: {} };
    }
    return { resolvedUrl: fetched.url, metadata: await readPageMetadata(response.body, contentType, fetched.signal) };
  } finally {
    fetched.release();
    // A body the metadata reader never took is cancelled here, so an unread page does not hold its connection open.
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

/** Fetches an image a page named; any failure leaves the preview without one. */
async function fetchPreviewImage(raw: string, pageUrl: URL, options: FetchOptions): Promise<FetchedImage | null> {
  try {
    let resolved: string;
    try {
      resolved = new URL(raw, pageUrl).href;
    } catch {
      throw new LinkPreviewFailure("unsupported", "Preview image URL is invalid");
    }
    const url = previewableUrl(resolved);
    return { url, ...await fetchImageBytes(url, options) };
  } catch (error) {
    if (!(error instanceof LinkPreviewFailure)) {
      console.warn("[LinkPreviews] Preview image fetch failed:", errorName(error));
    }
    return null;
  }
}

async function fetchImageBytes(url: URL, options: FetchOptions): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const fetched = await guardedFetch(url, IMAGE_ACCEPT, options);
  const { response } = fetched;
  try {
    if (!response.ok) throw new LinkPreviewFailure("unreachable", `Image responded with status ${response.status}`);
    if (!IMAGE_TYPES.has(mediaType(response.headers.get("content-type") ?? ""))) {
      throw new LinkPreviewFailure("unsupported", "Preview image type is not supported");
    }
    const length = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(length) && length > MAX_LINK_PREVIEW_IMAGE_BYTES) {
      throw new LinkPreviewFailure("too-large", "Preview image is too large");
    }
    if (!response.body) throw new LinkPreviewFailure("unsupported", "Preview image is empty");
    const bytes = await readBounded(response.body, MAX_LINK_PREVIEW_IMAGE_BYTES, fetched.signal);
    // The declared type only admits the response; the stored type comes from the bytes.
    const mimeType = sniffImageMimeType(bytes) ?? (isAvif(bytes) ? "image/avif" : undefined);
    if (!mimeType) throw new LinkPreviewFailure("unsupported", "Preview image bytes are not a supported image");
    return { bytes, mimeType };
  } finally {
    fetched.release();
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

type GuardedResponse = { response: Response; url: URL; signal: AbortSignal; release: () => void };

/** Fetches without following redirects itself, checking each hop's destination; each request has its own timeout covering its body. */
async function guardedFetch(start: URL, accept: string, options: FetchOptions): Promise<GuardedResponse> {
  let url = start;
  for (let hop = 0; ; hop += 1) {
    if (options.signal?.aborted) throw options.signal.reason;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new LinkPreviewFailure("timeout", "Link preview request timed out"));
    }, options.timeoutMs);
    const onDeadline = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onDeadline, { once: true });
    const release = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onDeadline);
    };
    let response: Response;
    try {
      response = await raceWithAbort(options.fetch(url.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { accept, "user-agent": USER_AGENT },
      }), controller.signal);
    } catch (error) {
      release();
      throw error instanceof LinkPreviewFailure
        ? error
        : new LinkPreviewFailure("unreachable", `Link preview request failed: ${errorName(error)}`);
    }
    if (!REDIRECT_STATUSES.has(response.status)) return { response, url, signal: controller.signal, release };
    release();
    await response.body?.cancel().catch(() => {});
    const location = response.headers.get("location");
    if (!location) throw new LinkPreviewFailure("unreachable", "Redirect has no location");
    if (hop >= MAX_REDIRECTS) throw new LinkPreviewFailure("unreachable", "Too many redirects");
    let next: string;
    try {
      next = new URL(location, url).href;
    } catch {
      throw new LinkPreviewFailure("unreachable", "Redirect location is invalid");
    }
    url = previewableUrl(next);
  }
}

/** Reads at most `limit` bytes, failing as too large past it and with the signal's reason when it aborts. */
async function readBounded(stream: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const reader = stream.getReader();
  const abort = () => void reader.cancel(signal.reason).catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new LinkPreviewFailure("too-large", "Response exceeded its size limit");
      }
      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Feeds at most the page byte limit through HTMLRewriter and stops pulling the
 * upstream body once the document head has ended.
 */
async function readPageMetadata(body: ReadableStream<Uint8Array>, contentType: string, signal: AbortSignal): Promise<PageMetadata> {
  const collector = new PageMetadataCollector();
  const upstream = body.getReader();
  const abort = () => void upstream.cancel(signal.reason).catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  let received = 0;
  // Upstream failures end the input cleanly and are raised after the rewriter drains, so none escapes through its pipe.
  let failure: unknown;
  const input = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (collector.done || received >= MAX_LINK_PREVIEW_PAGE_BYTES) {
        controller.close();
        await upstream.cancel().catch(() => {});
        return;
      }
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await upstream.read();
      } catch (error) {
        failure = error;
        controller.close();
        return;
      }
      if (part.done || signal.aborted) {
        controller.close();
        return;
      }
      const chunk = part.value.subarray(0, MAX_LINK_PREVIEW_PAGE_BYTES - received);
      received += chunk.byteLength;
      controller.enqueue(chunk);
    },
    async cancel(reason) {
      await upstream.cancel(reason).catch(() => {});
    },
  }, { highWaterMark: 0 });
  const rewritten = new HTMLRewriter()
    .on("head", { element: (element) => element.onEndTag(() => { collector.done = true; }) })
    .on("body", { element: () => { collector.done = true; } })
    .on("title", collector.titleHandler())
    .on("meta", { element: (element) => collector.meta(element) })
    .transform(new Response(input, { headers: { "content-type": contentType } }));
  try {
    const output = rewritten.body?.getReader();
    while (output && !(await output.read()).done) {
      // Drain the rewritten document; only the handlers' observations matter.
    }
  } catch (error) {
    failure ??= error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
  if (signal.aborted && signal.reason instanceof LinkPreviewFailure) throw signal.reason;
  if (failure !== undefined) {
    throw failure instanceof LinkPreviewFailure
      ? failure
      : new LinkPreviewFailure("unreachable", `Page body could not be read: ${errorName(failure)}`);
  }
  return collector.metadata();
}

const META_KEYS = new Set([
  "og:title",
  "og:description",
  "og:site_name",
  "og:image",
  "og:image:width",
  "og:image:height",
  "twitter:title",
  "twitter:description",
  "twitter:image",
  "twitter:image:src",
  "description",
]);

class PageMetadataCollector {
  done = false;
  private readonly values = new Map<string, string>();
  private title: string | null = null;
  private titleOpen = false;

  meta(element: Element): void {
    if (this.done) return;
    const key = (element.getAttribute("property") ?? element.getAttribute("name"))?.trim().toLowerCase();
    const content = element.getAttribute("content");
    if (!key || content === null || !META_KEYS.has(key) || this.values.has(key)) return;
    this.values.set(key, content);
  }

  titleHandler(): HTMLRewriterElementContentHandlers {
    return {
      element: (element) => {
        if (this.done || this.title !== null) return;
        this.title = "";
        this.titleOpen = true;
        element.onEndTag(() => { this.titleOpen = false; });
      },
      text: (text) => {
        if (this.titleOpen) this.title += text.text;
      },
    };
  }

  metadata(): PageMetadata {
    const value = (key: string) => this.values.get(key);
    const title = firstText(MAX_TITLE_LENGTH, value("og:title"), value("twitter:title"), this.title ?? undefined);
    const description = firstText(MAX_DESCRIPTION_LENGTH, value("og:description"), value("twitter:description"), value("description"));
    const siteName = firstText(MAX_SITE_NAME_LENGTH, value("og:site_name"));
    const ogImage = cleanText(value("og:image") ?? "");
    const imageUrl = ogImage || cleanText(value("twitter:image") ?? "") || cleanText(value("twitter:image:src") ?? "");
    const width = ogImage ? dimension(value("og:image:width")) : undefined;
    const height = ogImage ? dimension(value("og:image:height")) : undefined;
    return {
      ...(title ? { title } : undefined),
      ...(description ? { description } : undefined),
      ...(siteName ? { siteName } : undefined),
      ...(imageUrl
        ? { image: { url: imageUrl, ...(width ? { width } : undefined), ...(height ? { height } : undefined) } }
        : undefined),
    };
  }
}

function firstText(limit: number, ...candidates: (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    const text = cleanText(candidate ?? "");
    if (text) return capText(text, limit);
  }
  return undefined;
}

function cleanText(value: string): string {
  return decodeEntities(value).replace(/\s+/g, " ").trim();
}

function capText(value: string, limit: number): string {
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  return `${characters.slice(0, limit - 1).join("").trimEnd()}…`;
}

function dimension(value: string | undefined): number | undefined {
  if (!value || !/^\s*\d+\s*$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed > 0 && parsed <= MAX_IMAGE_DIMENSION ? parsed : undefined;
}

const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", "\""],
  ["apos", "'"],
  ["nbsp", " "],
  ["ndash", "–"],
  ["mdash", "—"],
  ["hellip", "…"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["laquo", "«"],
  ["raquo", "»"],
  ["middot", "·"],
  ["bull", "•"],
  ["copy", "©"],
  ["reg", "®"],
  ["trade", "™"],
]);

/** HTMLRewriter exposes attribute values and text as written, so character references are decoded here. */
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1] === "x" || entity[1] === "X"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES.get(entity.toLowerCase()) ?? match;
  });
}

function mediaType(contentType: string): string {
  return contentType.split(";", 1)[0].trim().toLowerCase();
}

function isAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const box = String.fromCharCode(...bytes.subarray(4, 12));
  return box === "ftypavif" || box === "ftypavis";
}

function failureCategory<ErrorValue>(error: ErrorValue): LinkPreviewFailureCategory {
  if (error instanceof LinkPreviewFailure) return error.category;
  console.warn("[LinkPreviews] Unexpected preview failure:", errorName(error));
  return "unreachable";
}

function errorName<ErrorValue>(error: ErrorValue): string {
  return error instanceof Error ? error.name : "non-error";
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
